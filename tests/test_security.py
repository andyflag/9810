"""Regression tests for workspace binding, revocation and streamed request limits."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import json
import secrets
import threading
import time

import pytest
from fastapi.testclient import TestClient

from backend import auth, db, main


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "security.sqlite3")
    with ExitStack() as stack:

        def create(email=None):
            client = stack.enter_context(TestClient(main.app, headers={"X-Requested-With": "9810"}))
            if email:
                response = client.post(
                    "/api/auth/register", json={"email": email, "password": "safe-password-9810"}
                )
                assert response.status_code == 200, response.text
                client.headers["X-Workspace-ID"] = response.json()["tenant_id"]
            return client

        yield create


def sku(name):
    return {"data": {"sku": name, "name": name, "unit": "件", "tax_rate": "0.13"}}


def join(owner, guest, email, role="editor"):
    invitation = owner.post("/api/invitations", json={"email": email, "role": role})
    assert invitation.status_code == 200, invitation.text
    response = guest.post("/api/invitations/accept", json={"token": invitation.json()["token"]})
    assert response.status_code == 200, response.text
    guest.headers["X-Workspace-ID"] = response.json()["tenant_id"]


def test_business_scope_is_explicit_and_download_scope_is_checked(clients):
    owner = clients("owner@example.com")
    workspace = owner.headers.pop("X-Workspace-ID")
    assert owner.get("/api/state").status_code == 200
    assert owner.get("/api/template").status_code == 200
    assert owner.post("/api/demo").status_code == 400
    for path in ["/api/export", "/api/audit", "/api/team", "/api/files/missing"]:
        assert owner.get(path).status_code == 400
    assert owner.get("/api/export", params={"workspace_id": workspace}).status_code == 200
    owner.headers["X-Workspace-ID"] = workspace
    assert owner.get("/api/state?workspace_id=another").status_code == 400
    assert owner.get("/api/state?workspace_id=x&workspace_id=x").status_code == 400
    assert owner.get("/api/state", headers={"X-Workspace-ID": "another"}).status_code == 403
    assert owner.post("/api/records/skus", json={"data": []}).status_code == 422


def test_shared_ip_login_budget_preserves_per_account_rate_limit(clients):
    client = clients("owner@example.com")
    for index in range(20):
        response = client.post(
            "/api/auth/login",
            json={"email": f"other-{index}@example.com", "password": "wrong-password"},
        )
        assert response.status_code == 401
    assert client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "safe-password-9810"},
    ).status_code == 200
    for _ in range(20):
        assert client.post(
            "/api/auth/login",
            json={"email": "target@example.com", "password": "wrong-password"},
        ).status_code == 401
    assert client.post(
        "/api/auth/login",
        json={"email": "target@example.com", "password": "wrong-password"},
    ).status_code == 429


def test_two_tabs_keep_their_explicit_workspace_after_default_switch(clients):
    first = clients("first@example.com")
    other = clients("other@example.com")
    tab_two = clients()
    company_a, company_b = first.headers["X-Workspace-ID"], other.headers["X-Workspace-ID"]
    join(other, first, "first@example.com")
    first.headers["X-Workspace-ID"] = company_a
    tab_two.cookies.set(auth.COOKIE, first.cookies.get(auth.COOKIE))
    response = tab_two.post(
        "/api/workspaces/switch",
        json={"tenant_id": company_b},
        headers={"X-Workspace-ID": "stale-old-view"},
    )
    assert response.status_code == 200 and response.json()["tenant_id"] == company_b
    assert first.post("/api/records/skus", json=sku("ONLY-COMPANY-A")).status_code == 200
    assert first.get("/api/state").json()["records"]["skus"][0]["sku"] == "ONLY-COMPANY-A"
    assert other.get("/api/state").json()["records"]["skus"] == []


def test_removed_editor_cannot_commit_a_request_authorized_before_revocation(clients, monkeypatch):
    owner = clients("owner@example.com")
    editor = clients("editor@example.com")
    own_company = editor.headers["X-Workspace-ID"]
    user_id = editor.get("/api/state").json()["user"]["id"]
    join(owner, editor, "editor@example.com")
    entered, release = threading.Event(), threading.Event()
    original = main.clean

    def pause(kind, data):
        result = original(kind, data)
        if data.get("sku") == "REVOKED-WRITE":
            entered.set()
            assert release.wait(10)
        return result

    monkeypatch.setattr(main, "clean", pause)
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(editor.post, "/api/records/skus", json=sku("REVOKED-WRITE"))
        try:
            assert entered.wait(10)
            assert owner.delete("/api/team/" + user_id).status_code == 200
        finally:
            release.set()
        assert pending.result().status_code == 403
    assert owner.get("/api/state").json()["records"]["skus"] == []
    assert editor.get("/api/state").status_code == 403
    editor.headers.pop("X-Workspace-ID")
    assert editor.get("/api/state").json()["user"]["tenant_id"] == own_company


def test_owner_role_is_rechecked_in_the_settings_transaction(clients, monkeypatch):
    owner = clients("owner@example.com")
    initial = owner.get("/api/state").json()
    entered, release = threading.Event(), threading.Event()
    original = main.clean_settings

    def pause(data):
        result = original(data)
        entered.set()
        assert release.wait(10)
        return result

    monkeypatch.setattr(main, "clean_settings", pause)
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(
            owner.put,
            "/api/settings",
            json={
                "data": {**initial["settings"], "company_name": "Unauthorized change"},
                "version": initial["revision"],
            },
        )
        try:
            assert entered.wait(10)
            with db.connect(write=True) as con:
                con.execute(
                    "UPDATE memberships SET role='editor' WHERE tenant_id=? AND user_id=?",
                    (initial["user"]["tenant_id"], initial["user"]["id"]),
                )
        finally:
            release.set()
        assert pending.result().status_code == 403
    assert owner.get("/api/state").json()["settings"] == initial["settings"]


def test_logged_out_session_cannot_commit_a_pending_write(clients, monkeypatch):
    client = clients("owner@example.com")
    entered, release = threading.Event(), threading.Event()
    original = main.clean

    def pause(kind, data):
        result = original(kind, data)
        entered.set()
        assert release.wait(10)
        return result

    monkeypatch.setattr(main, "clean", pause)
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(client.post, "/api/records/skus", json=sku("LOGGED-OUT-WRITE"))
        try:
            assert entered.wait(10)
            assert client.post("/api/auth/logout").status_code == 200
        finally:
            release.set()
        assert pending.result().status_code == 401
    with db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM records").fetchone()[0] == 0


def test_member_removal_invalidates_unused_invites_and_duplicate_invites_fail(clients):
    owner = clients("owner@example.com")
    editor = clients("editor@example.com")
    user_id = editor.get("/api/state").json()["user"]["id"]
    join(owner, editor, "editor@example.com")
    assert owner.post("/api/invitations", json={"email": "editor@example.com"}).status_code == 409
    token = secrets.token_urlsafe(32)
    # Simulate an unused invitation issued before the duplicate-invite fix.
    with db.connect(write=True) as con:
        con.execute(
            "INSERT INTO invitations(token_hash,tenant_id,email,role,expires_at) VALUES(?,?,?,?,?)",
            (
                auth.digest(token),
                owner.headers["X-Workspace-ID"],
                "editor@example.com",
                "editor",
                int(time.time()) + 86400,
            ),
        )
    assert owner.delete("/api/team/" + user_id).status_code == 200
    assert editor.post("/api/invitations/accept", json={"token": token}).status_code == 422
    assert editor.get("/api/state").status_code == 403


def test_actual_chunked_json_and_multipart_size_are_limited(clients):
    client = clients()
    payload = json.dumps(
        {
            "email": "oversized@example.com",
            "password": "safe-password-9810",
            "padding": "x" * (13 * 1024 * 1024),
        }
    ).encode()
    request = client.build_request(
        "POST",
        "/api/auth/register",
        content=iter([payload]),
        headers={"Content-Type": "application/json"},
    )
    assert "content-length" not in request.headers
    assert client.send(request).status_code == 413
    boundary = "size-test-boundary"
    multipart = (
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\n'
            "Content-Type: text/plain\r\n\r\n"
        ).encode()
        + b"x" * (13 * 1024 * 1024)
        + f"\r\n--{boundary}--\r\n".encode()
    )
    response = client.post(
        "/api/import",
        content=iter([multipart]),
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
    )
    assert response.status_code == 413
    assert (
        client.post(
            "/api/auth/register", content=b"{}", headers={"Content-Length": "bad"}
        ).status_code
        == 400
    )
    with db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0


def test_export_rendering_does_not_hold_global_writer_lock_or_change_revision(clients, monkeypatch):
    owner = clients("owner@example.com")
    other = clients("other@example.com")
    revision = owner.get("/api/state").json()["revision"]
    entered, release = threading.Event(), threading.Event()
    original = main.excel.export

    def pause(data, settings):
        entered.set()
        assert release.wait(10)
        return original(data, settings)

    monkeypatch.setattr(main.excel, "export", pause)
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(owner.get, "/api/export")
        try:
            assert entered.wait(10)
            write = pool.submit(other.post, "/api/records/skus", json=sku("OTHER-TENANT"))
            assert write.result(timeout=3).status_code == 200
        finally:
            release.set()
        assert pending.result().status_code == 200
    assert owner.get("/api/state").json()["revision"] == revision
