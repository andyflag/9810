"""Opaque, revocable server sessions; passwords never leave the server."""

import hashlib, hmac, os, re, secrets, time, uuid
from fastapi import HTTPException, Request, Response
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


def rate_limit(request, account):
    now = int(time.time())
    key = digest((request.client.host if request.client else "local") + ":" + account)
    with db.connect(write=True) as con:
        con.execute("DELETE FROM login_attempts WHERE window_start<?", (now - 900,))
        row = con.execute("SELECT count FROM login_attempts WHERE key=?", (key,)).fetchone()
        if row and row["count"] >= 20:
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


def context(request: Request):
    token = request.cookies.get(COOKIE, "")
    if not token:
        raise HTTPException(401, "请先登录")
    with db.connect() as con:
        row = con.execute(
            """SELECT s.user_id,s.tenant_id,s.token_hash,m.role,u.email,u.name
        FROM sessions s JOIN users u ON u.id=s.user_id
        JOIN memberships m ON m.user_id=s.user_id AND m.tenant_id=s.tenant_id
        WHERE s.token_hash=? AND s.expires_at>?""",
            (digest(token), int(time.time())),
        ).fetchone()
        if not row:
            raise HTTPException(401, "登录已过期，请重新登录")
        return dict(row)


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
