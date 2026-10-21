"""Accounts, access control, rate limits, the database index (history, retention, quotas) and monitoring."""

import time

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def app():
    from terrax.api.main import app as a

    return a


def new_client(app) -> TestClient:
    return TestClient(app)  # a fresh cookie jar: another browser


def sample(c: TestClient, name: str = "terrain_dem_synthetic.tif") -> str:
    r = c.post("/api/samples", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def signup(c: TestClient, email: str, password: str = "correct horse battery") -> dict:
    r = c.post("/api/auth/signup", json={"email": email, "password": password, "name": email.split("@")[0]})
    assert r.status_code == 201, r.text
    return r.json()


def uniq(prefix: str) -> str:
    return f"{prefix}.{time.time_ns()}@example.org"


# ── Passwords ────────────────────────────────────────────────────────────────


def test_password_hashes_are_salted_scrypt_and_verify():
    from terrax import auth

    a, b = auth.hash_password("a long passphrase"), auth.hash_password("a long passphrase")
    assert a != b and a.startswith("scrypt$32768$8$3$")  # OWASP's N = 2^15, r = 8, p = 3
    assert auth.verify_password("a long passphrase", a) and not auth.verify_password("a long passphrasE", a)
    assert not auth.verify_password("x", "not-a-hash") and not auth.verify_password("x", "bcrypt$1$2$3$4$5")


# ── Guests only see their own data ───────────────────────────────────────────


def test_a_guest_cannot_reach_another_guests_files_jobs_or_results(app):
    a, b = new_client(app), new_client(app)
    fid = sample(a)
    job = a.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": fid}}).json()
    assert job["state"] == "done"
    art = job["result"]["layers"]["slope"]
    assert a.get(f"/api/files/{fid}").status_code == 200 and a.get(art).status_code == 200
    # b knows every ID and still gets "not found" (the same answer as for something that does not exist).
    assert b.get(f"/api/files/{fid}").status_code == 404
    assert b.get(f"/api/files/{fid}/content").status_code == 404
    assert b.get(f"/api/jobs/{job['id']}").status_code == 404
    assert b.get(art).status_code == 404
    assert b.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": fid}}).status_code == 404
    assert b.get(f"/api/rasters/{fid}/pixel", params={"col": 1, "row": 1, "width": 10, "height": 10}).status_code == 404
    assert b.delete(f"/api/files/{fid}").status_code == 404 and b.delete(f"/api/jobs/{job['id']}").status_code == 404
    # Each sees only their own history and uploads.
    assert [j["id"] for j in a.get("/api/jobs").json()["jobs"]] == [job["id"]]
    assert b.get("/api/jobs").json()["jobs"] == [] and b.get("/api/files").json()["files"] == []
    mine = a.get("/api/files").json()
    assert [f["id"] for f in mine["files"]] == [fid] and mine["usedBytes"] > 0


def test_hydrology_and_landcover_follow_ups_check_the_owner(app):
    a, b = new_client(app), new_client(app)
    dem = sample(a)
    h = a.post("/api/jobs", json={"tool": "hydrology", "inputs": {"dem": dem}, "params": {"thresholdKm2": 0.5}}).json()
    url = f"/api/terrain/{h['id']}/watershed"
    assert a.post(url, json={"col": 120, "row": 195}).status_code == 200
    assert b.post(url, json={"col": 120, "row": 195}).status_code == 404
    img = sample(a, "satellite_4band_synthetic.tif")
    lc = a.post("/api/jobs", json={"tool": "landcover", "inputs": {"file": img}, "params": {"bands": [0, 1, 2, 3], "k": 3}}).json()
    assert b.post(f"/api/landcover/{lc['id']}/sample", json={}).status_code == 404
    assert a.post(f"/api/landcover/{lc['id']}/sample", json={}).status_code == 200


# ── Accounts ─────────────────────────────────────────────────────────────────


def test_signup_keeps_guest_work_then_sign_out_and_back_in(app):
    c = new_client(app)
    fid = sample(c)
    job = c.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": fid}}).json()
    email = uniq("ana")
    me = signup(c, email)
    assert me["user"]["email"] == email and me["user"]["role"] == "user" and me["claimed"] == 2  # the upload and the job
    hist = c.get("/api/jobs").json()["jobs"]
    assert [j["id"] for j in hist] == [job["id"]] and hist[0]["name"] == "terrain_dem_synthetic.tif" and hist[0]["expires"] > time.time() + 20 * 86400
    assert c.post("/api/auth/logout").json()["ok"]
    assert c.get("/api/auth/me").json()["user"] is None
    assert c.get(f"/api/jobs/{job['id']}").status_code == 404  # signed out: a guest again
    other = new_client(app)
    assert other.post("/api/auth/login", json={"email": email.upper(), "password": "wrong password!"}).status_code == 401
    r = other.post("/api/auth/login", json={"email": email.upper(), "password": "correct horse battery"})
    assert r.status_code == 200 and r.json()["user"]["email"] == email
    assert other.get(f"/api/jobs/{job['id']}").status_code == 200  # the same history on another device


def test_signup_rules(app, monkeypatch):
    c = new_client(app)
    for body, code, text in [
        ({"email": "not-an-email", "password": "long enough pass"}, 400, "valid e-mail"),
        ({"email": uniq("b"), "password": "short"}, 400, "at least 8"),
    ]:
        r = c.post("/api/auth/signup", json=body)
        assert r.status_code == code and text in r.json()["detail"]
    email = uniq("same")
    signup(c, email)
    assert new_client(app).post("/api/auth/signup", json={"email": email, "password": "another passphrase"}).status_code == 409
    monkeypatch.setenv("TERRAX_SIGNUP", "closed")
    assert new_client(app).post("/api/auth/signup", json={"email": uniq("c"), "password": "long enough pass"}).status_code == 403


def test_password_change_signs_out_other_devices(app):
    email = uniq("pw")
    a = new_client(app)
    signup(a, email)
    b = new_client(app)
    assert b.post("/api/auth/login", json={"email": email, "password": "correct horse battery"}).status_code == 200
    assert a.post("/api/auth/password", json={"current": "nope nope nope", "new": "a brand new phrase"}).status_code == 401
    assert a.post("/api/auth/password", json={"current": "correct horse battery", "new": "a brand new phrase"}).status_code == 200
    assert a.get("/api/auth/me").json()["user"]["email"] == email  # this device signed in again
    assert b.get("/api/auth/me").json()["user"] is None  # the other one was signed out
    assert b.post("/api/auth/login", json={"email": email, "password": "a brand new phrase"}).status_code == 200


def test_deleting_an_account_deletes_its_data(app):
    from terrax import storage

    c = new_client(app)
    signup(c, uniq("del"))
    fid = sample(c)
    folder = storage.root() / "files" / fid
    assert folder.exists()
    assert c.post("/api/auth/delete-account", json={"password": "wrong wrong wrong"}).status_code == 401
    assert c.post("/api/auth/delete-account", json={"password": "correct horse battery"}).json()["ok"]
    assert not folder.exists() and c.get("/api/auth/me").json()["user"] is None


def test_required_mode_turns_guests_away(app, monkeypatch):
    monkeypatch.setenv("TERRAX_AUTH", "required")
    c = new_client(app)
    assert c.get("/api/health").json()["auth"] == "required"
    r = c.post("/api/samples", json={"name": "terrain_dem_synthetic.tif"})
    assert r.status_code == 401 and "Sign in" in r.json()["detail"]
    assert c.get("/api/jobs").status_code == 401 and c.post("/api/agents/chat", json={"question": "hi"}).status_code == 401
    assert c.get("/api/maps/catalog").status_code == 200  # public reference data
    assert "terrax_guest" not in c.cookies
    signup(c, uniq("req"))
    assert c.post("/api/samples", json={"name": "terrain_dem_synthetic.tif"}).status_code == 201


def test_bearer_tokens_work_for_scripts(app):
    from terrax import auth

    email = uniq("bot")
    u = auth.create_user(email, "script passphrase")
    token = auth.start_session(u["id"], "127.0.0.1", "pytest")
    c = new_client(app)
    assert c.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["user"]["email"] == email


# ── Projects ─────────────────────────────────────────────────────────────────


def test_projects_saved_on_the_server_and_shared(app):
    owner, friend, stranger = new_client(app), new_client(app), new_client(app)
    signup(owner, (oe := uniq("own")))
    signup(friend, (fe := uniq("fr")))
    signup(stranger, uniq("st"))
    assert new_client(app).get("/api/projects").status_code == 401  # guests keep projects in their browser
    doc = {"version": 1, "boundary": None, "reports": [{"title": "Plot A", "markdown": "# A"}]}
    pr = owner.post("/api/projects", json={"name": "Kohima survey", "data": doc}).json()
    assert pr["access"] == "owner"
    assert owner.get(f"/api/projects/{pr['id']}").json()["data"] == doc
    assert friend.get(f"/api/projects/{pr['id']}").status_code == 404
    assert owner.post(f"/api/projects/{pr['id']}/shares", json={"email": "nobody@example.org"}).status_code == 404
    share = owner.post(f"/api/projects/{pr['id']}/shares", json={"email": fe, "canEdit": False}).json()
    listed = friend.get("/api/projects").json()["projects"]
    assert [(p["id"], p["access"], p["ownerEmail"]) for p in listed] == [(pr["id"], "read", oe)]
    assert friend.put(f"/api/projects/{pr['id']}", json={"name": "mine now"}).status_code == 403
    owner.post(f"/api/projects/{pr['id']}/shares", json={"email": fe, "canEdit": True})
    assert friend.put(f"/api/projects/{pr['id']}", json={"data": doc | {"boundary": {"name": "B"}}}).json()["access"] == "edit"
    assert owner.get(f"/api/projects/{pr['id']}").json()["data"]["boundary"] == {"name": "B"}
    assert friend.delete(f"/api/projects/{pr['id']}").status_code == 403 and stranger.get(f"/api/projects/{pr['id']}").status_code == 404
    assert [s["email"] for s in owner.get(f"/api/projects/{pr['id']}").json()["shares"]] == [fe]
    assert friend.delete(f"/api/projects/{pr['id']}/shares/{share['userId']}").status_code == 204  # leaving a shared project
    assert friend.get("/api/projects").json()["projects"] == []
    assert owner.delete(f"/api/projects/{pr['id']}").status_code == 204 and owner.get("/api/projects").json()["projects"] == []


# ── Administration ───────────────────────────────────────────────────────────


def _admin(app) -> TestClient:
    from terrax import auth

    email = uniq("admin")
    auth.create_user(email, "admin passphrase", "Admin", "admin")
    c = new_client(app)
    assert c.post("/api/auth/login", json={"email": email, "password": "admin passphrase"}).status_code == 200
    return c


def test_admin_only_endpoints_and_user_management(app):
    user = new_client(app)
    signup(user, (ue := uniq("u")))
    assert user.get("/api/admin/users").status_code == 403 and new_client(app).get("/api/admin/stats").status_code == 401
    adm = _admin(app)
    users = adm.get("/api/admin/users", params={"q": ue}).json()["users"]
    assert [u["email"] for u in users] == [ue]
    uid = users[0]["id"]
    assert adm.patch(f"/api/admin/users/{uid}", json={"disabled": True}).json()["disabled"]
    assert user.get("/api/auth/me").json()["user"] is None  # disabling ends the user's sessions
    assert new_client(app).post("/api/auth/login", json={"email": ue, "password": "correct horse battery"}).status_code == 401
    made = adm.post("/api/admin/users", json={"email": uniq("made"), "password": "made by admin", "role": "admin"}).json()
    assert made["role"] == "admin"
    stats = adm.get("/api/admin/stats").json()
    assert stats["users"] >= 3 and "jobsLastDay" in stats


def test_the_last_admin_cannot_be_removed(app, monkeypatch):
    from sqlalchemy import update

    from terrax import auth, db

    adm = _admin(app)
    me = adm.get("/api/auth/me").json()["user"]
    with db.connect() as c:  # leave this the only active admin
        c.execute(update(db.users).where(db.users.c.role == "admin", db.users.c.id != me["id"]).values(disabled=True))
    assert auth.count_admins() == 1
    r = adm.patch(f"/api/admin/users/{me['id']}", json={"role": "user"})
    assert r.status_code == 400 and "only administrator" in r.json()["detail"]
    with db.connect() as c:
        c.execute(update(db.users).where(db.users.c.role == "admin").values(disabled=False))


def test_admin_account_from_the_environment(monkeypatch):
    from terrax import auth

    email = uniq("boot")
    monkeypatch.setenv("TERRAX_ADMIN_EMAIL", email)
    monkeypatch.setenv("TERRAX_ADMIN_PASSWORD", "bootstrap passphrase")
    auth.ensure_admin()
    u = auth.user_by_email(email)
    assert u and u["role"] == "admin" and auth.verify_password("bootstrap passphrase", u["password_hash"])
    monkeypatch.setenv("TERRAX_ADMIN_PASSWORD", "rotated passphrase")
    auth.ensure_admin()  # changing the variable resets the password
    u2 = auth.user_by_email(email)
    assert u2 and auth.verify_password("rotated passphrase", u2["password_hash"])


# ── Rate limits, quotas, cross-site requests ─────────────────────────────────


def test_rate_limits_answer_429_with_retry_after(app, monkeypatch):
    from terrax import ratelimit

    ratelimit.reset()
    monkeypatch.setenv("TERRAX_RATE_LIMITS", "true")
    monkeypatch.setenv("TERRAX_JOBS_PER_MINUTE", "2")
    c = new_client(app)
    fid = sample(c)
    codes = [c.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": fid}}).status_code for _ in range(3)]
    assert codes[:2] == [202, 202] and codes[2] == 429
    r = c.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": fid}})
    assert int(r.headers["Retry-After"]) >= 1 and "at most 2 per minute" in r.json()["detail"]
    # Guessing passwords: ten tries per address and per e-mail in 15 minutes.
    email = uniq("guess")
    signup(new_client(app), email)
    g = new_client(app)
    tries = [g.post("/api/auth/login", json={"email": email, "password": f"wrong {i:04d} guess"}).status_code for i in range(11)]
    assert tries[:10] == [401] * 10 and tries[10] == 429
    ratelimit.reset()


def test_storage_quota(app, monkeypatch):
    monkeypatch.setenv("TERRAX_GUEST_QUOTA_MB", "1")
    c = new_client(app)
    sample(c)  # 0.26 MB
    r = c.post("/api/files", files={"file": ("big.bin", b"x" * 900_000)})
    assert r.status_code == 413 and "storage" in r.json()["detail"]


def test_cross_site_writes_are_refused(app):
    c = new_client(app)
    evil = c.post("/api/samples", json={"name": "terrain_dem_synthetic.tif"}, headers={"Origin": "https://evil.example"})
    assert evil.status_code == 403
    assert c.post("/api/samples", json={"name": "terrain_dem_synthetic.tif"}, headers={"Origin": "http://testserver"}).status_code == 201
    assert c.post("/api/samples", json={"name": "terrain_dem_synthetic.tif"}, headers={"Origin": "http://localhost:5173"}).status_code == 201  # TERRAX_CORS
    assert c.get("/api/samples", headers={"Origin": "https://evil.example"}).status_code == 200  # reads are not writes


# ── Retention and history ────────────────────────────────────────────────────


def test_purge_removes_expired_folders_and_keeps_history(app):
    from sqlalchemy import update

    from terrax import db, storage

    c = new_client(app)
    fid = sample(c)
    job = c.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": fid}}).json()
    with db.connect() as conn:
        for t, i in ((db.files, fid), (db.jobs, job["id"])):
            conn.execute(update(t).where(t.c.id == i).values(expires=time.time() - 1))
    assert storage.purge_old() >= 2
    assert not (storage.root() / "files" / fid).exists() and not storage.job_dir(job["id"]).exists()
    hist = c.get("/api/jobs").json()["jobs"]
    assert hist[0]["id"] == job["id"] and hist[0]["expired"] and hist[0]["state"] == "done"
    assert c.get(f"/api/jobs/{job['id']}").status_code == 404 and c.get(f"/api/files/{fid}").status_code == 404


def test_expiry_depends_on_the_owner(monkeypatch):
    from terrax import storage

    now = 1_000_000.0
    assert storage.expiry("g:x", now) == now + 72 * 3600
    assert storage.expiry("u:x", now) == now + 30 * 86400
    monkeypatch.setenv("TERRAX_USER_RETENTION_DAYS", "0")
    assert storage.expiry("u:x", now) is None


# ── Monitoring ───────────────────────────────────────────────────────────────


def test_request_ids_readiness_and_metrics(app, monkeypatch):
    c = new_client(app)
    r = c.get("/api/health", headers={"X-Request-ID": "trace-123"})
    assert r.headers["X-Request-ID"] == "trace-123"
    assert len(c.get("/api/health").headers["X-Request-ID"]) == 32
    ready = c.get("/api/health/ready").json()
    assert ready["ok"] and ready["checks"]["database"] and ready["checks"]["storage"]
    assert c.get("/api/metrics").status_code == 401
    monkeypatch.setenv("TERRAX_METRICS_TOKEN", "s3cret")
    assert c.get("/api/metrics", headers={"Authorization": "Bearer wrong"}).status_code == 401
    sample(c)
    m = c.get("/api/metrics", headers={"Authorization": "Bearer s3cret"})
    assert m.status_code == 200 and m.headers["content-type"].startswith("text/plain; version=0.0.4")
    text = m.text
    assert 'terrax_http_requests_total{method="POST",route="/api/samples",status="2xx"}' in text
    assert 'terrax_http_request_duration_seconds_bucket{method="POST",route="/api/samples",le="+Inf"}' in text
    assert "terrax_jobs_in_flight" in text and "terrax_stored_bytes" in text
    monkeypatch.delenv("TERRAX_METRICS_TOKEN")
    assert _admin(app).get("/api/metrics").status_code == 200


def test_unhandled_errors_are_recorded_with_the_request_id(app, monkeypatch):
    from terrax import storage

    c = new_client(app)
    fid = sample(c)

    def boom(_fid):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(storage, "get_file", boom)
    r = c.get(f"/api/files/{fid}")
    assert r.status_code == 500 and r.json()["requestId"] in r.json()["detail"] and r.headers["X-Request-ID"] == r.json()["requestId"]
    monkeypatch.undo()
    assert c.post("/api/client-errors", json={"kind": "TypeError", "message": "x is undefined", "stack": "at App.tsx:10", "page": "http://testserver/tools?x=1"}).status_code == 204
    errs = _admin(app).get("/api/admin/errors").json()["errors"]
    server = next(e for e in errs if e["message"] == "disk on fire")
    assert server["source"] == "server" and server["kind"] == "RuntimeError" and server["requestId"] == r.json()["requestId"] and "Traceback" in server["detail"]
    client = next(e for e in errs if e["message"] == "x is undefined")
    assert client["source"] == "client" and client["path"] == "/tools"


def test_failed_jobs_are_recorded_as_worker_errors(app, monkeypatch):
    from terrax.tools import load_all

    tools = load_all()

    def broken(ctx, inputs, params):
        raise ZeroDivisionError("bad maths")

    monkeypatch.setitem(tools, "terrain", broken)
    c = new_client(app)
    job = c.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": sample(c)}}).json()
    assert job["state"] == "error" and "ZeroDivisionError" in job["message"] and "trace" not in job
    errs = _admin(app).get("/api/admin/errors", params={"source": "worker"}).json()["errors"]
    assert any(e["kind"] == "ZeroDivisionError" and e["path"] == f"job:terrain:{job['id']}" for e in errs)


def test_command_line_administration(monkeypatch, capsys):
    from terrax import auth, manage

    email = uniq("cli")
    monkeypatch.setenv("TERRAX_NEW_PASSWORD", "from the command line")
    assert manage.main(["create-user", email, "--admin"]) == 0
    u = auth.user_by_email(email)
    assert u and u["role"] == "admin"
    manage.main(["disable", email])
    u = auth.user_by_email(email)
    assert u and u["disabled"]
    manage.main(["list-users"])
    manage.main(["check"])
    out = capsys.readouterr().out
    assert email in out and "database" in out and "TERRAX_AUTH=optional" in out
    with pytest.raises(SystemExit, match="already exists"):
        manage.main(["create-user", email])


def test_cookies_for_an_app_shown_in_another_sites_frame(app, monkeypatch):
    c = new_client(app)
    lax = c.get("/api/auth/me").headers["set-cookie"].lower()
    assert "httponly" in lax and "samesite=lax" in lax and "partitioned" not in lax
    monkeypatch.setenv("TERRAX_COOKIE_SAMESITE", "none")
    framed = new_client(app).get("/api/auth/me").headers["set-cookie"].lower()
    assert "samesite=none" in framed and "secure" in framed and "partitioned" in framed  # third-party frames (Hugging Face Spaces) keep the cookie
