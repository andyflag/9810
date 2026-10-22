"""Opaque, revocable server sessions; passwords never leave the server."""

import hashlib
import hmac
import os
import re
import secrets
import time
import uuid
from contextlib import contextmanager
from fastapi import HTTPException, Request
from . import db

COOKIE = "session9810"
SECURE = os.getenv("APP_ENV", "development") == "production"


def uid():
    return uuid.uuid4().hex


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def email(value):
    value = str(value).strip().lower()
    if not re.fullmatch(r"[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,30}", value):
        raise HTTPException(422, "请输入有效邮箱")
    return value


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    result = hashlib.scrypt(
        password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=64
    ).hex()
    return salt + ":" + result


def verify(password, stored):
    salt = stored.split(":")[0]
    return hmac.compare_digest(password_hash(password, salt), stored)


def validate_password(value):
    if not 10 <= len(value) <= 128:
        raise HTTPException(422, "密码须为 10–128 个字符")


def rate_limit(request, account, limit=20):
    now = int(time.time())
    key = digest((request.client.host if request.client else "local") + ":" + account)
    with db.connect(write=True) as con:
        con.execute("DELETE FROM login_attempts WHERE window_start<?", (now - 900,))
        row = con.execute("SELECT count FROM login_attempts WHERE key=?", (key,)).fetchone()
        if row and row["count"] >= limit:
            raise HTTPException(429, "尝试次数过多，请 15 分钟后重试")
        con.execute(
            "INSERT INTO login_attempts(key,count,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
            (key, now),
        )


def new_session(con, response, user_id, tenant_id):
    token = secrets.token_urlsafe(32)
    con.execute("DELETE FROM sessions WHERE expires_at<?", (int(time.time()),))
    con.execute(
        "INSERT INTO sessions VALUES(?,?,?,?)",
        (digest(token), user_id, tenant_id, int(time.time()) + 7 * 86400),
    )
    response.set_cookie(
        COOKIE, token, httponly=True, secure=SECURE, samesite="lax", max_age=7 * 86400, path="/"
    )


IDENTITY_PATHS = frozenset(
    ["/api/auth/logout", "/api/workspaces/switch", "/api/invitations/accept"]
)
DEFAULT_WORKSPACE_PATHS = frozenset(["/api/state", "/api/template"])


def selected_workspace(request: Request):
    """Bind each request to the workspace displayed by its originating view."""
    header = request.headers.get("X-Workspace-ID")
    query_values = request.query_params.getlist("workspace_id")
    if len(query_values) > 1:
        raise HTTPException(400, "企业标识不能重复")
    query = query_values[0] if query_values else None
    if header is not None and query is not None and header != query:
        raise HTTPException(400, "请求中的企业标识不一致")
    selected = header if header is not None else query
    if selected is not None and (
        not selected or selected != selected.strip() or len(selected) > 150
    ):
        raise HTTPException(400, "企业标识无效")
    return selected


def session_context(con, token_hash):
    row = con.execute(
        """SELECT s.user_id,s.tenant_id,s.token_hash,u.email,u.name
        FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>?""",
        (token_hash, int(time.time())),
    ).fetchone()
    if not row:
        raise HTTPException(401, "登录已过期，请重新登录")
    return dict(row)


def check_membership(con, ctx, required="read"):
    membership = con.execute(
        "SELECT role FROM memberships WHERE tenant_id=? AND user_id=?",
        (ctx["tenant_id"], ctx["user_id"]),
    ).fetchone()
    if not membership:
        raise HTTPException(403, "无权访问该企业，或企业访问权限已被撤销")
    role = membership["role"]
    if required == "owner" and role != "owner":
        raise HTTPException(403, "只有管理员可以执行此操作")
    if required == "write" and role not in ("owner", "editor"):
        raise HTTPException(403, "只读成员不能修改数据")
    return role


def recheck(con, ctx, required="read", identity=False):
    """Revalidate inside the same transaction that performs protected writes."""
    current = session_context(con, ctx["token_hash"])
    if current["user_id"] != ctx["user_id"]:
        raise HTTPException(401, "登录已过期，请重新登录")
    if not identity:
        check_membership(con, ctx, required)


@contextmanager
def transaction(ctx, required="write", identity=False):
    with db.connect(write=True) as con:
        recheck(con, ctx, required, identity)
        yield con


def context(request: Request):
    token = request.cookies.get(COOKIE, "")
    if not token:
        raise HTTPException(401, "请先登录")
    identity_only = request.url.path in IDENTITY_PATHS
    selected = None if identity_only else selected_workspace(request)
    with db.connect() as con:
        ctx = session_context(con, digest(token))
        if identity_only:
            return ctx
        if selected is None and request.url.path not in DEFAULT_WORKSPACE_PATHS:
            raise HTTPException(400, "请明确选择当前企业后重试")
        if selected is not None:
            ctx["tenant_id"] = selected
        ctx["role"] = check_membership(con, ctx)
        return ctx


def write_context(request: Request):
    ctx = context(request)
    if ctx["role"] == "viewer":
        raise HTTPException(403, "只读成员不能修改数据")
    return ctx


def owner_context(request: Request):
    ctx = write_context(request)
    if ctx["role"] != "owner":
        raise HTTPException(403, "只有管理员可以执行此操作")
    return ctx
