from contextlib import contextmanager
import json
import os
import sqlite3
from pathlib import Path
from .domain import ORDER, DEFAULT_SETTINGS

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).parent.parent / "data"))
DB_PATH = DATA_DIR / "9810.sqlite3"


@contextmanager
def connect(write=False):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=20)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 20000")
    try:
        if write:
            con.execute("BEGIN IMMEDIATE")
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def initialize():
    with connect() as con:
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript("""
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS tenants (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS memberships (
          tenant_id TEXT REFERENCES tenants(id), user_id TEXT REFERENCES users(id),
          role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(tenant_id,user_id));
        CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id,tenant_id);
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          tenant_id TEXT NOT NULL REFERENCES tenants(id), expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS sessions_tenant_user ON sessions(tenant_id,user_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
          kind TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS records_tenant_kind ON records(tenant_id,kind);
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL REFERENCES tenants(id),
          user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target TEXT NOT NULL,
          before_json TEXT, after_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant_id,id DESC);
        CREATE TABLE IF NOT EXISTS invitations (
          token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
          email TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT);
        CREATE INDEX IF NOT EXISTS invitations_tenant_email ON invitations(tenant_id,email);
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
          record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
          name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS files_tenant ON files(tenant_id);
        CREATE INDEX IF NOT EXISTS files_record ON files(record_id);
        CREATE TABLE IF NOT EXISTS login_attempts (
          key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS login_attempts_window ON login_attempts(window_start);
        PRAGMA user_version = 1;
        """)


def dataset(con, tenant_id):
    result = {kind: [] for kind in ORDER}
    for row in con.execute(
        "SELECT * FROM records WHERE tenant_id=? ORDER BY created_at,rowid", (tenant_id,)
    ):
        result[row["kind"]].append(
            {**json.loads(row["payload"]), "id": row["id"], "version": row["version"]}
        )
    return result


def settings(con, tenant_id):
    return {
        **DEFAULT_SETTINGS,
        **json.loads(
            con.execute("SELECT settings FROM tenants WHERE id=?", (tenant_id,)).fetchone()[0]
        ),
    }


def audit(con, ctx, action, target, before=None, after=None, change_revision=True):
    con.execute(
        "INSERT INTO audit(tenant_id,user_id,action,target,before_json,after_json) VALUES (?,?,?,?,?,?)",
        (
            ctx["tenant_id"],
            ctx["user_id"],
            action,
            target,
            json.dumps(before, ensure_ascii=False) if before is not None else None,
            json.dumps(after, ensure_ascii=False) if after is not None else None,
        ),
    )
    if change_revision:
        con.execute("UPDATE tenants SET revision=revision+1 WHERE id=?", (ctx["tenant_id"],))
