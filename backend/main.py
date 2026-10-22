from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime
from urllib.parse import quote
import json
import os
import secrets
import sqlite3
import time
import re
from fastapi import FastAPI, Depends, HTTPException, Request, Response, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from pydantic import BaseModel, Field
from . import db, auth, excel
from .domain import (
    SCHEMA,
    ORDER,
    DEFAULT_SETTINGS,
    RuleError,
    clean,
    clean_settings,
    compute,
    validate_state,
    allocate_money,
)


@asynccontextmanager
async def lifespan(app):
    db.initialize()
    yield


app = FastAPI(
    title="9810 核销 SaaS API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs" if os.getenv("APP_ENV") != "production" else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if os.getenv("APP_ENV") != "production" else None,
)

MAX_REQUEST_BYTES = 12 * 1024 * 1024


class RequestSizeLimitMiddleware:
    """Protect requests without buffering bodies or wrapping receive exceptions."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def protected_send(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["Referrer-Policy"] = "same-origin"
                if scope["path"].startswith("/api/"):
                    headers["Cache-Control"] = "no-store"
                else:
                    headers["Content-Security-Policy"] = (
                        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                        "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
                        "base-uri 'self'; frame-ancestors 'none'"
                    )
            await send(message)

        lengths = [value for key, value in scope["headers"] if key.lower() == b"content-length"]
        if lengths and (
            any(not re.fullmatch(rb"[0-9]{1,20}", value) for value in lengths)
            or len(set(lengths)) != 1
        ):
            response = JSONResponse({"detail": "Content-Length 格式无效"}, 400)
            return await response(scope, receive, protected_send)
        if lengths and int(lengths[0]) > MAX_REQUEST_BYTES:
            response = JSONResponse({"detail": "请求不得超过 12 MB"}, 413)
            return await response(scope, receive, protected_send)
        if scope["method"] in ("POST", "PUT", "PATCH", "DELETE"):
            request_headers = {key.lower(): value for key, value in scope["headers"]}
            # Browsers cannot send this cross-origin without CORS permission.
            if request_headers.get(b"x-requested-with") != b"9810":
                response = JSONResponse({"detail": "无效的请求来源，请从应用内重试"}, 403)
                return await response(scope, receive, protected_send)
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_REQUEST_BYTES:
                    raise HTTPException(413, "请求不得超过 12 MB")
            return message

        await self.app(scope, bounded_receive, protected_send)


app.add_middleware(RequestSizeLimitMiddleware)


@app.exception_handler(RuleError)
async def rule_error(request, exc):
    return JSONResponse({"detail": str(exc)}, 422)


class Account(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(min_length=1, max_length=128)
    name: str = Field(default="", max_length=100)
    company_name: str = Field(default="我的企业", max_length=100)


class RecordInput(BaseModel):
    data: dict
    version: int | None = None


class InviteInput(BaseModel):
    email: str
    role: str = "editor"


class TokenInput(BaseModel):
    token: str = Field(max_length=200)


class SwitchInput(BaseModel):
    tenant_id: str = Field(max_length=64)


class FifoInput(BaseModel):
    sku: str
    settlement_id: str
    month: str
    quantity: int = Field(gt=0, le=1000000000)
    gross: str
    fees: str
    sale_date: str | None = None
    evidence_date: str | None = None
    commit: bool = False
    revision: int | None = None


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "1.0.0"}


@app.post("/api/auth/register")
def register(body: Account, request: Request, response: Response):
    account = auth.email(body.email)
    auth.validate_password(body.password)
    auth.rate_limit(request, "register")
    name = body.name.strip() or account.split("@")[0]
    company = body.company_name.strip()
    if not company:
        raise HTTPException(422, "请填写企业名称")
    user_id, tenant_id = auth.uid(), auth.uid()
    hashed = auth.password_hash(body.password)
    try:
        with db.connect(write=True) as con:
            con.execute(
                "INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)",
                (user_id, account, name, hashed),
            )
            con.execute(
                "INSERT INTO tenants(id,name,settings) VALUES(?,?,?)",
                (
                    tenant_id,
                    company,
                    json.dumps({**DEFAULT_SETTINGS, "company_name": company}, ensure_ascii=False),
                ),
            )
            con.execute("INSERT INTO memberships VALUES(?,?,?)", (tenant_id, user_id, "owner"))
            auth.new_session(con, response, user_id, tenant_id)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "该邮箱已注册，请登录") from None
    return {"ok": True, "tenant_id": tenant_id}


@app.post("/api/auth/login")
def login(body: Account, request: Request, response: Response):
    account = auth.email(body.email)
    auth.rate_limit(request, account)
    # A shared office IP can serve many accounts; keep the per-account cap tight.
    auth.rate_limit(request, "all-logins", limit=200)
    with db.connect(write=True) as con:
        user = con.execute("SELECT * FROM users WHERE email=?", (account,)).fetchone()
        stored = user["password_hash"] if user else "00" * 16 + ":" + "00" * 64
        if not auth.verify(body.password, stored) or not user:
            raise HTTPException(401, "邮箱或密码不正确")
        tenant = con.execute(
            "SELECT tenant_id FROM memberships WHERE user_id=? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,tenant_id LIMIT 1",
            (user["id"],),
        ).fetchone()
        auth.new_session(con, response, user["id"], tenant["tenant_id"])
    return {"ok": True, "tenant_id": tenant["tenant_id"]}


@app.post("/api/auth/logout")
def logout(response: Response, ctx=Depends(auth.context)):
    with auth.transaction(ctx, identity=True) as con:
        con.execute("DELETE FROM sessions WHERE token_hash=?", (ctx["token_hash"],))
    response.delete_cookie(auth.COOKIE, path="/")
    return {"ok": True}


@app.get("/api/state")
def state(ctx=Depends(auth.context)):
    with db.connect() as con:
        con.execute("BEGIN")
        auth.recheck(con, ctx)
        settings = db.settings(con, ctx["tenant_id"])
        result = compute(db.dataset(con, ctx["tenant_id"]), settings)
        tenant = con.execute(
            "SELECT revision FROM tenants WHERE id=?", (ctx["tenant_id"],)
        ).fetchone()
        workspaces = [
            dict(r)
            for r in con.execute(
                "SELECT t.id,t.name,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=?",
                (ctx["user_id"],),
            )
        ]
        files = [
            dict(r)
            for r in con.execute(
                "SELECT id,record_id,name,size,created_at FROM files WHERE tenant_id=?",
                (ctx["tenant_id"],),
            )
        ]
    return {
        **result,
        "schema": SCHEMA,
        "settings": settings,
        "revision": tenant["revision"],
        "user": {
            "id": ctx["user_id"],
            "email": ctx["email"],
            "name": ctx["name"],
            "role": ctx["role"],
            "tenant_id": ctx["tenant_id"],
        },
        "workspaces": workspaces,
        "files": files,
    }


@app.post("/api/workspaces/switch")
def switch(body: SwitchInput, ctx=Depends(auth.context)):
    with auth.transaction(ctx, identity=True) as con:
        if not con.execute(
            "SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=?",
            (body.tenant_id, ctx["user_id"]),
        ).fetchone():
            raise HTTPException(403, "无权访问该企业")
        con.execute(
            "UPDATE sessions SET tenant_id=? WHERE token_hash=?",
            (body.tenant_id, ctx["token_hash"]),
        )
    return {"ok": True, "tenant_id": body.tenant_id}


@app.get("/api/team")
def team(ctx=Depends(auth.owner_context)):
    with db.connect() as con:
        con.execute("BEGIN")
        auth.recheck(con, ctx, "owner")
        members = [
            dict(r)
            for r in con.execute(
                "SELECT u.id,u.email,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=?",
                (ctx["tenant_id"],),
            )
        ]
    return members


@app.post("/api/invitations")
def invite(body: InviteInput, ctx=Depends(auth.owner_context)):
    email = auth.email(body.email)
    if body.role not in ["editor", "viewer"]:
        raise HTTPException(422, "邀请角色必须为编辑或只读")
    token = secrets.token_urlsafe(32)
    with auth.transaction(ctx, required="owner") as con:
        if con.execute(
            "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND u.email=?",
            (ctx["tenant_id"], email),
        ).fetchone():
            raise HTTPException(409, "该邮箱已是企业成员，无需重复邀请")
        con.execute(
            "DELETE FROM invitations WHERE tenant_id=? AND email=? AND used_at IS NULL",
            (ctx["tenant_id"], email),
        )
        con.execute(
            "INSERT INTO invitations(token_hash,tenant_id,email,role,expires_at) VALUES(?,?,?,?,?)",
            (auth.digest(token), ctx["tenant_id"], email, body.role, int(time.time()) + 7 * 86400),
        )
        db.audit(con, ctx, "邀请成员", email, after={"role": body.role})
    return {"token": token, "expires_days": 7}


@app.post("/api/invitations/accept")
def accept(body: TokenInput, ctx=Depends(auth.context)):
    with auth.transaction(ctx, identity=True) as con:
        row = con.execute(
            "SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
            (auth.digest(body.token), int(time.time())),
        ).fetchone()
        if not row:
            raise HTTPException(422, "邀请已过期或已使用")
        if row["email"] != ctx["email"]:
            raise HTTPException(403, "请使用受邀邮箱登录")
        con.execute(
            "INSERT INTO memberships VALUES(?,?,?) ON CONFLICT DO NOTHING",
            (row["tenant_id"], ctx["user_id"], row["role"]),
        )
        con.execute(
            "UPDATE invitations SET used_at=CURRENT_TIMESTAMP WHERE token_hash=?",
            (auth.digest(body.token),),
        )
        con.execute(
            "UPDATE sessions SET tenant_id=? WHERE token_hash=?",
            (row["tenant_id"], ctx["token_hash"]),
        )
        db.audit(con, {**ctx, "tenant_id": row["tenant_id"]}, "加入企业", ctx["email"])
    return {"ok": True, "tenant_id": row["tenant_id"]}


@app.delete("/api/team/{user_id}")
def remove_member(user_id: str, ctx=Depends(auth.owner_context)):
    with auth.transaction(ctx, required="owner") as con:
        row = con.execute(
            "SELECT m.role,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.user_id=?",
            (ctx["tenant_id"], user_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "成员不存在")
        if row["role"] == "owner":
            raise HTTPException(409, "不能移除管理员")
        con.execute(
            "DELETE FROM memberships WHERE tenant_id=? AND user_id=?", (ctx["tenant_id"], user_id)
        )
        con.execute(
            "DELETE FROM invitations WHERE tenant_id=? AND email=? AND used_at IS NULL",
            (ctx["tenant_id"], row["email"]),
        )
        fallback = con.execute(
            "SELECT tenant_id FROM memberships WHERE user_id=? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,tenant_id LIMIT 1",
            (user_id,),
        ).fetchone()
        if fallback:
            con.execute(
                "UPDATE sessions SET tenant_id=? WHERE tenant_id=? AND user_id=?",
                (fallback["tenant_id"], ctx["tenant_id"], user_id),
            )
        else:
            con.execute(
                "DELETE FROM sessions WHERE tenant_id=? AND user_id=?", (ctx["tenant_id"], user_id)
            )
        db.audit(con, ctx, "移除成员", user_id)
    return {"ok": True}


def get_record(con, ctx, kind, record_id):
    if kind not in SCHEMA:
        raise HTTPException(404, "台账不存在")
    row = con.execute(
        "SELECT * FROM records WHERE id=? AND tenant_id=? AND kind=?",
        (record_id, ctx["tenant_id"], kind),
    ).fetchone()
    if not row:
        raise HTTPException(404, "记录不存在")
    return row


def insert_record(con, ctx, kind, data):
    record_id = auth.uid()
    con.execute(
        "INSERT INTO records(id,tenant_id,kind,payload) VALUES(?,?,?,?)",
        (record_id, ctx["tenant_id"], kind, json.dumps(data, ensure_ascii=False)),
    )
    return record_id


@app.post("/api/records/{kind}")
def create_record(kind: str, body: RecordInput, ctx=Depends(auth.write_context)):
    data = clean(kind, body.data)
    with auth.transaction(ctx) as con:
        records = db.dataset(con, ctx["tenant_id"])
        records[kind].append(data)
        validate_state(records, db.settings(con, ctx["tenant_id"]))
        record_id = insert_record(con, ctx, kind, data)
        db.audit(con, ctx, "新增记录", kind + ":" + record_id, after=data)
    return {"id": record_id}


@app.put("/api/records/{kind}/{record_id}")
def update_record(kind: str, record_id: str, body: RecordInput, ctx=Depends(auth.write_context)):
    data = clean(kind, body.data)
    with auth.transaction(ctx) as con:
        old = get_record(con, ctx, kind, record_id)
        if body.version != old["version"]:
            raise HTTPException(409, "记录已被其他成员修改，请刷新后重新编辑")
        records = db.dataset(con, ctx["tenant_id"])
        records[kind] = [data if r["id"] == record_id else r for r in records[kind]]
        validate_state(records, db.settings(con, ctx["tenant_id"]))
        con.execute(
            "UPDATE records SET payload=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?",
            (json.dumps(data, ensure_ascii=False), record_id, ctx["tenant_id"]),
        )
        db.audit(
            con,
            ctx,
            "更新记录",
            kind + ":" + record_id,
            before=json.loads(old["payload"]),
            after=data,
        )
    return {"ok": True}


@app.delete("/api/records/{kind}/{record_id}")
def delete_record(kind: str, record_id: str, version: int, ctx=Depends(auth.write_context)):
    with auth.transaction(ctx) as con:
        old = get_record(con, ctx, kind, record_id)
        if version != old["version"]:
            raise HTTPException(409, "记录已更新，请刷新后重试")
        records = db.dataset(con, ctx["tenant_id"])
        records[kind] = [r for r in records[kind] if r["id"] != record_id]
        validate_state(records, db.settings(con, ctx["tenant_id"]))
        con.execute("DELETE FROM records WHERE tenant_id=? AND id=?", (ctx["tenant_id"], record_id))
        db.audit(con, ctx, "删除记录", kind + ":" + record_id, before=json.loads(old["payload"]))
    return {"ok": True}


@app.put("/api/settings")
def save_settings(body: RecordInput, ctx=Depends(auth.owner_context)):
    settings = clean_settings(body.data)
    with auth.transaction(ctx, required="owner") as con:
        revision = con.execute(
            "SELECT revision FROM tenants WHERE id=?", (ctx["tenant_id"],)
        ).fetchone()[0]
        if body.version != revision:
            raise HTTPException(409, "数据已更新，请刷新后重新保存参数")
        old = db.settings(con, ctx["tenant_id"])
        validate_state(db.dataset(con, ctx["tenant_id"]), settings)
        con.execute(
            "UPDATE tenants SET name=?,settings=? WHERE id=?",
            (settings["company_name"], json.dumps(settings, ensure_ascii=False), ctx["tenant_id"]),
        )
        db.audit(con, ctx, "修改企业参数", "settings", before=old, after=settings)
    return {"ok": True}


@app.get("/api/audit")
def audit_log(ctx=Depends(auth.owner_context)):
    with db.connect() as con:
        con.execute("BEGIN")
        auth.recheck(con, ctx, "owner")
        return [
            dict(r)
            for r in con.execute(
                "SELECT a.id,a.action,a.target,a.created_at,u.name,a.before_json,a.after_json FROM audit a JOIN users u ON u.id=a.user_id WHERE a.tenant_id=? ORDER BY a.id DESC LIMIT 200",
                (ctx["tenant_id"],),
            )
        ]


@app.post("/api/demo")
def demo(ctx=Depends(auth.write_context)):
    sample = json.loads((Path(__file__).parent / "sample.json").read_text())
    with auth.transaction(ctx) as con:
        if con.execute("SELECT 1 FROM records WHERE tenant_id=?", (ctx["tenant_id"],)).fetchone():
            raise HTTPException(409, "只能在空企业中载入示例，现有数据不会被覆盖")
        sample = {k: [clean(k, r) for r in sample[k]] for k in ORDER}
        validate_state(sample, db.settings(con, ctx["tenant_id"]))
        for kind in ORDER:
            for r in sample[kind]:
                insert_record(con, ctx, kind, r)
        db.audit(con, ctx, "载入模板示例", "demo", after={k: len(v) for k, v in sample.items()})
    return {"ok": True}


@app.post("/api/sales/fifo")
def fifo(body: FifoInput, ctx=Depends(auth.write_context)):
    with db.connect(write=body.commit) as con:
        if not body.commit:
            con.execute("BEGIN")
        auth.recheck(con, ctx, "write")
        revision = con.execute(
            "SELECT revision FROM tenants WHERE id=?", (ctx["tenant_id"],)
        ).fetchone()[0]
        if body.commit and body.revision != revision:
            raise HTTPException(409, "台账已变化，请重新预览 FIFO 分配")
        data = db.dataset(con, ctx["tenant_id"])
        settings = db.settings(con, ctx["tenant_id"])
        computed = compute(data, settings)
        receipt = next(
            (r for r in data["receipts"] if r["settlement_id"] == body.settlement_id), None
        )
        if not receipt:
            raise RuleError("使用 FIFO 前请先登记对应结算报告")
        lots = sorted(
            [
                r
                for r in computed["ledger"]
                if r["sku"] == body.sku
                and r["currency"] == receipt["currency"]
                and (not receipt.get("site") or r.get("site") == receipt["site"])
                and r["remaining"] > 0
            ],
            key=lambda r: (r["export_date"], r["ledger_id"]),
        )
        remaining = body.quantity
        result = []
        for lot in lots:
            qty = min(remaining, lot["remaining"])
            if not qty:
                break
            result.append(
                {
                    "month": body.month,
                    "settlement_id": body.settlement_id,
                    "sku": body.sku,
                    "ledger_id": lot["ledger_id"],
                    "sold_qty": qty,
                    "returned_qty": 0,
                    "gross": 0,
                    "fees": 0,
                    "site": lot.get("site"),
                    "sale_date": body.sale_date,
                    "evidence_date": body.evidence_date,
                    "notes": "FIFO 自动分配",
                }
            )
            remaining -= qty
        if remaining:
            raise RuleError(f"可用库存不足，还差 {remaining} 件；请核对 SKU、站点和币种")
        try:
            weights = [r["sold_qty"] for r in result]
            for field in ["gross", "fees"]:
                for row, allocated in zip(result, allocate_money(getattr(body, field), weights)):
                    row[field] = allocated
        except Exception:
            raise RuleError("销售金额或费用格式不正确") from None
        result = [clean("sales", r) for r in result]
        data["sales"].extend(result)
        validate_state(data, settings)
        if body.commit:
            ids = [insert_record(con, ctx, "sales", r) for r in result]
            db.audit(con, ctx, "FIFO 销量分配", body.sku, after={"records": result, "ids": ids})
        return {"rows": result, "revision": revision, "committed": body.commit}


@app.post("/api/import")
async def import_workbook(
    file: UploadFile = File(...), dry_run: bool = True, ctx=Depends(auth.write_context)
):
    content = await file.read(excel.MAX_XLSX + 1)
    incoming, workbook_settings = excel.parse(content)
    with db.connect(write=not dry_run) as con:
        if dry_run:
            con.execute("BEGIN")
        auth.recheck(con, ctx, "write")
        current = db.dataset(con, ctx["tenant_id"])
        combined, new, skipped = excel.merge(current, incoming)
        validate_state(combined, db.settings(con, ctx["tenant_id"]))
        counts = {k: sum(kind == k for kind, r in new) for k in ORDER}
        if not dry_run:
            for kind, r in new:
                insert_record(con, ctx, kind, r)
            if new:
                db.audit(
                    con, ctx, "导入 Excel", "workbook", after={"counts": counts, "skipped": skipped}
                )
    return {
        "counts": counts,
        "total": len(new),
        "skipped": skipped,
        "examples": sum("示例" in str(r.get("notes", "")) for k, r in new),
        "committed": not dry_run,
        "workbook_settings": workbook_settings,
    }


@app.get("/api/export")
def export_workbook(ctx=Depends(auth.context)):
    with db.connect() as con:
        con.execute("BEGIN")
        auth.recheck(con, ctx)
        data = db.dataset(con, ctx["tenant_id"])
        settings = db.settings(con, ctx["tenant_id"])
    # Workbook rendering must not hold SQLite's global writer lock.
    content = excel.export(data, settings)
    with auth.transaction(ctx, required="read") as con:
        db.audit(con, ctx, "导出台账", "workbook", change_revision=False)
    filename = quote("9810核销台账-" + datetime.now().strftime("%Y%m%d") + ".xlsx")
    return Response(
        content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@app.get("/api/template")
def template(ctx=Depends(auth.context)):
    return FileResponse(
        Path(__file__).parent.parent / "docs/亚马逊9810核销台账模板-初版.xlsx",
        filename="9810-template.xlsx",
    )


@app.post("/api/documents/{record_id}/files")
async def upload_file(
    record_id: str, file: UploadFile = File(...), ctx=Depends(auth.write_context)
):
    content = await file.read(10 * 1024 * 1024 + 1)
    if not content or len(content) > 10 * 1024 * 1024:
        raise HTTPException(422, "附件需为 1 字节至 10 MB")
    name = Path(file.filename or "附件").name[:200]
    allowed = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".txt": "text/plain",
        ".csv": "text/csv",
    }
    mime = allowed.get(Path(name).suffix.lower())
    if not mime:
        raise HTTPException(422, "支持 PDF、PNG、JPG、XLSX、DOCX、TXT 和 CSV 附件")
    file_id = auth.uid()
    with auth.transaction(ctx) as con:
        get_record(con, ctx, "documents", record_id)
        used = con.execute(
            "SELECT COALESCE(SUM(size),0) FROM files WHERE tenant_id=?", (ctx["tenant_id"],)
        ).fetchone()[0]
        if used + len(content) > 100 * 1024 * 1024:
            raise HTTPException(422, "当前企业附件总容量上限为 100 MB")
        con.execute(
            "INSERT INTO files(id,tenant_id,record_id,name,mime,size,content) VALUES(?,?,?,?,?,?,?)",
            (file_id, ctx["tenant_id"], record_id, name, mime, len(content), content),
        )
        db.audit(
            con,
            ctx,
            "上传单证",
            record_id,
            after={"id": file_id, "name": name, "size": len(content)},
        )
    return {"id": file_id}


@app.get("/api/files/{file_id}")
def download_file(file_id: str, ctx=Depends(auth.context)):
    with db.connect() as con:
        con.execute("BEGIN")
        auth.recheck(con, ctx)
        row = con.execute(
            "SELECT * FROM files WHERE tenant_id=? AND id=?", (ctx["tenant_id"], file_id)
        ).fetchone()
        if not row:
            raise HTTPException(404, "附件不存在")
        return Response(
            bytes(row["content"]),
            media_type=row["mime"],
            headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(row["name"])},
        )


@app.delete("/api/files/{file_id}")
def remove_file(file_id: str, ctx=Depends(auth.write_context)):
    with auth.transaction(ctx) as con:
        row = con.execute(
            "SELECT name,record_id FROM files WHERE tenant_id=? AND id=?",
            (ctx["tenant_id"], file_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "附件不存在")
        con.execute("DELETE FROM files WHERE tenant_id=? AND id=?", (ctx["tenant_id"], file_id))
        db.audit(
            con, ctx, "删除单证", row["record_id"], before={"id": file_id, "name": row["name"]}
        )
    return {"ok": True}


DIST = Path(__file__).parent.parent / "frontend/dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "接口不存在")
        return FileResponse(DIST / "index.html")
