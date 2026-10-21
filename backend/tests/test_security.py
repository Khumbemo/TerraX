"""E-mail links, two-factor sign-in, single sign-on, sessions per device, the audit log and signed media links."""

import base64
import hashlib
import json
import re
import socketserver
import threading
import time
from email import message_from_bytes
from email.message import Message
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from tests.test_accounts import _admin, new_client, sample, signup, uniq


@pytest.fixture()
def app():
    from terrax.api.main import app as a

    return a


# ── A real SMTP server (RFC 5321, the commands smtplib uses) on localhost ───


class _Smtp(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        w = self.wfile.write
        w(b"220 test ESMTP\r\n")
        while line := self.rfile.readline():
            cmd = line.decode().strip().upper()
            if cmd.startswith(("EHLO", "HELO")):
                w(b"250 test\r\n")
            elif cmd.startswith(("MAIL", "RCPT", "RSET", "NOOP")):
                w(b"250 OK\r\n")
            elif cmd == "DATA":
                w(b"354 go ahead\r\n")
                data = b""
                while (chunk := self.rfile.readline()) not in (b".\r\n", b""):
                    data += chunk[1:] if chunk.startswith(b"..") else chunk
                assert isinstance(self.server, _SmtpServer)
                self.server.inbox.append(message_from_bytes(data))
                w(b"250 queued\r\n")
            elif cmd == "QUIT":
                w(b"221 bye\r\n")
                return
            else:
                w(b"502 not implemented\r\n")


class _SmtpServer(socketserver.ThreadingTCPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _Smtp)
        self.inbox: list[Message] = []


@pytest.fixture()
def inbox(monkeypatch):
    server = _SmtpServer()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("TERRAX_SMTP_HOST", "127.0.0.1")
    monkeypatch.setenv("TERRAX_SMTP_PORT", str(server.server_address[1]))
    monkeypatch.setenv("TERRAX_SMTP_SECURITY", "none")
    monkeypatch.setenv("TERRAX_SMTP_FROM", "terrax@example.org")
    monkeypatch.setenv("TERRAX_PUBLIC_URL", "https://terrax.example.org")
    yield server.inbox
    server.shutdown()
    server.server_close()


def _link(inbox: list, to: str, param: str) -> str:
    msg = next(m for m in reversed(inbox) if m["To"] == to)
    body = msg.get_payload(decode=True).decode()
    url = re.search(r"https://terrax\.example\.org/\?\S+", body)
    assert url, body
    return parse_qs(urlparse(url.group(0)).query)[param][0]


# ── Password reset and address confirmation ──────────────────────────────────


def test_password_reset_by_e_mail(app, inbox):
    c = new_client(app)
    email = uniq("reset")
    signup(c, email)
    other = new_client(app)  # signed in on a second device
    assert other.post("/api/auth/login", json={"email": email, "password": "correct horse battery"}).status_code == 200
    # The same answer for an unknown address (no account discovery), and no mail for it.
    assert new_client(app).post("/api/auth/forgot", json={"email": uniq("nobody")}).json() == {"ok": True}
    assert not any(m["To"].startswith("nobody") for m in inbox)
    assert new_client(app).post("/api/auth/forgot", json={"email": email.upper()}).json() == {"ok": True}
    token = _link(inbox, email, "reset")
    r = new_client(app).post("/api/auth/reset", json={"token": token, "password": "a brand new passphrase"})
    assert r.status_code == 200 and r.json()["email"] == email
    # Used once only; every session ended; the new password works and the old one does not.
    assert new_client(app).post("/api/auth/reset", json={"token": token, "password": "another passphrase"}).status_code == 400
    assert other.get("/api/auth/me").json()["user"] is None
    assert new_client(app).post("/api/auth/login", json={"email": email, "password": "correct horse battery"}).status_code == 401
    assert new_client(app).post("/api/auth/login", json={"email": email, "password": "a brand new passphrase"}).status_code == 200
    assert new_client(app).post("/api/auth/reset", json={"token": "x" * 43, "password": "a brand new passphrase"}).status_code == 400


def test_mail_links_never_follow_the_host_header(app, monkeypatch, inbox):
    email = uniq("poison")
    signup(new_client(app), email)
    new_client(app).post("/api/auth/forgot", json={"email": email}, headers={"Host": "evil.example", "X-Forwarded-Host": "evil.example"})
    msg = next(m for m in reversed(inbox) if m["To"] == email)
    body = msg.get_payload(decode=True).decode()
    assert "https://terrax.example.org/?reset=" in body and "evil" not in body
    monkeypatch.setenv("TERRAX_PUBLIC_URL", "")  # without it the server does not send mail at all
    assert new_client(app).post("/api/auth/forgot", json={"email": email}).status_code == 503


def test_reset_needs_mail_and_links_expire(app, monkeypatch, inbox):
    from terrax import auth, db

    email = uniq("expire")
    signup(new_client(app), email)
    new_client(app).post("/api/auth/forgot", json={"email": email})
    token = _link(inbox, email, "reset")
    with db.connect() as c:
        c.execute(db.tokens.update().where(db.tokens.c.token_hash == auth._digest(token)).values(expires=time.time() - 1))
    assert new_client(app).post("/api/auth/reset", json={"token": token, "password": "a brand new passphrase"}).status_code == 400
    monkeypatch.setenv("TERRAX_SMTP_HOST", "")
    r = new_client(app).post("/api/auth/forgot", json={"email": email})
    assert r.status_code == 503 and "administrator" in r.json()["detail"]


def test_required_confirmation_blocks_work_until_the_link_is_opened(app, monkeypatch, inbox):
    monkeypatch.setenv("TERRAX_VERIFY_EMAIL", "true")
    c = new_client(app)
    email = uniq("verify")
    me = signup(c, email)
    assert me["verificationSent"] and me["user"]["emailVerified"] is False and me["verifyEmail"]
    r = c.post("/api/samples", json={"name": "terrain_dem_synthetic.tif"})
    assert r.status_code == 403 and email in r.json()["detail"]
    assert c.get("/api/auth/sessions").status_code == 200  # the account's own settings still work
    assert c.post("/api/auth/verify/resend").json() == {"sent": True}
    token = _link(inbox, email, "verify")
    assert new_client(app).post("/api/auth/verify", json={"token": token}).json()["email"] == email
    assert c.get("/api/auth/me").json()["user"]["emailVerified"] is True
    sample(c)
    assert c.post("/api/auth/verify/resend").json() == {"sent": False, "verified": True}
    # Without the requirement an unconfirmed account works as before.
    monkeypatch.setenv("TERRAX_VERIFY_EMAIL", "false")
    d = new_client(app)
    signup(d, uniq("noverify"))
    sample(d)


def test_failed_mail_does_not_fail_sign_up(app, monkeypatch):
    monkeypatch.setenv("TERRAX_SMTP_HOST", "127.0.0.1")
    monkeypatch.setenv("TERRAX_SMTP_PORT", "1")  # nothing listens there
    monkeypatch.setenv("TERRAX_SMTP_SECURITY", "none")
    monkeypatch.setenv("TERRAX_SMTP_FROM", "terrax@example.org")
    me = signup(new_client(app), uniq("nomail"))
    assert me["verificationSent"] is False and me["user"]


# ── Two-factor sign-in ───────────────────────────────────────────────────────


def test_totp_matches_the_rfc_6238_test_vectors():
    from terrax import totp

    secret = base64.b32encode(b"12345678901234567890").decode()  # RFC 6238 appendix B, SHA-1
    for t, code in [(59, "94287082"), (1111111109, "07081804"), (1234567890, "89005924"), (2000000000, "69279037")]:
        assert totp.hotp(secret, t // 30) == code[-6:]  # the RFC lists 8 digits; 6-digit codes are their last six
    assert totp.match(secret, "287 082", None, at=59) == 1
    assert totp.match(secret, "287082", 1, at=59) is None  # already used
    assert totp.match(secret, "287082", None, at=59 + 30) == 1  # one step of drift
    assert totp.match(secret, "287082", None, at=59 + 90) is None
    assert totp.uri("JBSWY3DPEHPK3PXP", "a@b.org").startswith("otpauth://totp/TerraX%3Aa%40b.org?secret=JBSWY3DPEHPK3PXP&issuer=TerraX")


def _code(secret: str, offset: int = 0) -> str:
    from terrax import totp

    return totp.hotp(secret, totp.step() + offset)


def test_two_factor_sign_in(app):
    c = new_client(app)
    email = uniq("totp")
    signup(c, email)
    setup = c.post("/api/auth/2fa/setup").json()
    secret = setup["secret"]
    assert len(base64.b32decode(secret + "=" * (-len(secret) % 8))) == 20 and "otpauth://totp/" in setup["uri"]
    assert c.post("/api/auth/2fa/enable", json={"code": "000000" if _code(secret) != "000000" else "111111"}).status_code == 400
    on = c.post("/api/auth/2fa/enable", json={"code": _code(secret)}).json()
    assert on["enabled"] and len(set(on["recoveryCodes"])) == 10
    assert c.get("/api/auth/me").json()["user"]["twoFactor"] is True
    assert c.post("/api/auth/2fa/setup").status_code == 400

    d = new_client(app)
    pw = {"email": email, "password": "correct horse battery"}
    step1 = d.post("/api/auth/login", json=pw)
    assert step1.json() == {"twoFactor": True} and d.get("/api/auth/me").json()["user"] is None  # no session yet
    assert d.post("/api/auth/login", json=pw | {"code": "12"}).status_code == 401
    assert d.post("/api/auth/login", json={**pw, "password": "wrong", "code": _code(secret)}).status_code == 401
    # The code used to turn it on is spent: a replay is refused, the next one works.
    assert d.post("/api/auth/login", json=pw | {"code": _code(secret)}).status_code == 401
    assert d.post("/api/auth/login", json=pw | {"code": _code(secret, 1)}).status_code == 200
    assert d.get("/api/auth/me").json()["user"]["email"] == email
    # A recovery code works once.
    rc = on["recoveryCodes"][0]
    assert new_client(app).post("/api/auth/login", json=pw | {"code": rc.upper()}).status_code == 200
    assert new_client(app).post("/api/auth/login", json=pw | {"code": rc}).status_code == 401
    # New recovery codes replace the old ones; turning it off needs the password and a code.
    fresh = c.post("/api/auth/2fa/recovery-codes", json={"code": on["recoveryCodes"][1]}).json()["recoveryCodes"]
    assert new_client(app).post("/api/auth/login", json=pw | {"code": on["recoveryCodes"][2]}).status_code == 401
    assert c.post("/api/auth/2fa/disable", json={"password": "wrong", "code": fresh[0]}).status_code == 401
    assert c.post("/api/auth/2fa/disable", json={"password": "correct horse battery", "code": fresh[1]}).json() == {"enabled": False}
    assert new_client(app).post("/api/auth/login", json=pw).json()["user"]["email"] == email


def test_an_admin_can_turn_off_two_factor_and_confirm_addresses(app):
    from terrax import auth

    c = new_client(app)
    email = uniq("lostphone")
    uid = signup(c, email)["user"]["id"]
    secret = c.post("/api/auth/2fa/setup").json()["secret"]
    c.post("/api/auth/2fa/enable", json={"code": _code(secret)})
    adm = _admin(app)
    assert adm.patch(f"/api/admin/users/{uid}", json={"twoFactor": True}).status_code == 400
    u = adm.patch(f"/api/admin/users/{uid}", json={"twoFactor": False, "emailVerified": True}).json()
    assert u["twoFactor"] is False and u["emailVerified"] is True
    assert (auth.get_user(uid) or {}).get("totp_secret") is None
    entries = adm.get("/api/admin/audit", params={"action": "admin.", "q": email}).json()["entries"]
    assert entries[0]["action"] == "admin.user_changed" and json.loads(entries[0]["detail"]) == {"emailVerified": True, "twoFactor": False}


# ── Sessions per device ──────────────────────────────────────────────────────


def test_sessions_are_listed_and_can_be_ended_one_by_one(app):
    email = uniq("devices")
    a = new_client(app)
    signup(a, email)
    b, c = new_client(app), new_client(app)
    for x, ua in ((b, "Firefox on a phone"), (c, "Chrome on a laptop")):
        assert x.post("/api/auth/login", json={"email": email, "password": "correct horse battery"}, headers={"User-Agent": ua}).status_code == 200
    listed = a.get("/api/auth/sessions").json()["sessions"]
    assert len(listed) == 3 and sum(s["current"] for s in listed) == 1
    assert all("token" not in s and len(s["id"]) == 16 for s in listed)
    phone = next(s for s in listed if s["userAgent"] == "Firefox on a phone")
    assert a.delete(f"/api/auth/sessions/{phone['id']}").status_code == 204
    assert b.get("/api/auth/me").json()["user"] is None and c.get("/api/auth/me").json()["user"]
    assert a.delete(f"/api/auth/sessions/{phone['id']}").status_code == 404
    assert a.delete("/api/auth/sessions/zzzz").status_code == 404
    # Someone else's session id is "not found" too.
    other = new_client(app)
    signup(other, uniq("stranger"))
    mine = next(s for s in a.get("/api/auth/sessions").json()["sessions"] if s["current"])
    assert other.delete(f"/api/auth/sessions/{mine['id']}").status_code == 404
    assert a.post("/api/auth/sessions/end-others").json() == {"ended": 1}
    assert c.get("/api/auth/me").json()["user"] is None and a.get("/api/auth/me").json()["user"]["email"] == email
    assert new_client(app).get("/api/auth/sessions").status_code == 401


# ── The audit log ────────────────────────────────────────────────────────────


def test_security_events_are_audited_without_secrets(app):
    email = uniq("audited")
    c = new_client(app)
    signup(c, email)
    new_client(app).post("/api/auth/login", json={"email": email, "password": "not the password"})
    c.post("/api/auth/password", json={"current": "correct horse battery", "new": "a second passphrase"})
    adm = _admin(app)
    entries = adm.get("/api/admin/audit", params={"q": email}).json()["entries"]
    actions = [e["action"] for e in entries]
    assert actions[:3] == ["auth.password_changed", "auth.login_failed", "auth.signup"]
    assert json.loads(entries[1]["detail"]) == {"reason": "password"} and entries[1]["ip"]
    blob = json.dumps(entries)
    assert "not the password" not in blob and "a second passphrase" not in blob and "correct horse" not in blob
    assert all("%" in e["target"] + e["actor"] for e in adm.get("/api/admin/audit", params={"q": "%"}).json()["entries"])  # a literal %, not a wildcard
    assert c.get("/api/admin/audit").status_code == 403


def test_old_audit_entries_are_purged(app, monkeypatch):
    from terrax import audit, db

    audit.record("test.old", target="old@example.org")
    with db.connect() as c:
        c.execute(db.audit.update().where(db.audit.c.action == "test.old").values(at=time.time() - 400 * 86400))
    monkeypatch.setenv("TERRAX_AUDIT_RETENTION_DAYS", "365")
    assert audit.purge() >= 1
    with db.connect() as c:
        assert c.execute(db.audit.select().where(db.audit.c.action == "test.old")).first() is None


# ── Single sign-on (OpenID Connect) with a stand-in provider ─────────────────


ISS = "https://idp.example.org"


def _jwt(claims: dict) -> str:
    def enc(d: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")

    return f"{enc({'alg': 'RS256'})}.{enc(claims)}.c2lnbmF0dXJl"


@pytest.fixture()
def idp(monkeypatch):
    from terrax import oidc

    monkeypatch.setenv("TERRAX_OIDC_ISSUER", ISS)
    monkeypatch.setenv("TERRAX_OIDC_CLIENT_ID", "terrax-client")
    monkeypatch.setenv("TERRAX_OIDC_CLIENT_SECRET", "s3cret")
    monkeypatch.setenv("TERRAX_OIDC_NAME", "Example ID")
    monkeypatch.setenv("TERRAX_PUBLIC_URL", "https://terrax.example.org")
    oidc._discovery.clear()
    state: dict = {"claims": {}, "posts": []}

    def get_json(url: str, headers=None) -> dict:
        assert url == f"{ISS}/.well-known/openid-configuration"
        return {"issuer": ISS, "authorization_endpoint": f"{ISS}/authorize", "token_endpoint": f"{ISS}/token"}

    def post_form(url: str, data: dict, auth: tuple) -> dict:
        state["posts"].append((url, data, auth))
        return {"id_token": _jwt(state["claims"]), "access_token": "at"}

    monkeypatch.setattr(oidc, "_get_json", get_json)
    monkeypatch.setattr(oidc, "_post_form", post_form)
    yield state
    oidc._discovery.clear()


def _sso(c: TestClient, idp: dict, **claims) -> str:
    """Runs the redirect flow; returns where TerraX sends the browser back to."""
    r = c.get("/api/auth/oidc/start", follow_redirects=False)
    assert r.status_code == 303, r.text
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["code_challenge_method"] == ["S256"] and q["redirect_uri"] == ["https://terrax.example.org/api/auth/oidc/callback"]
    base = {"iss": ISS, "aud": "terrax-client", "exp": time.time() + 300, "iat": time.time(), "nonce": q["nonce"][0], "sub": "abc"}
    idp["claims"] = {k: v for k, v in (base | claims).items() if v is not None}
    back = c.get("/api/auth/oidc/callback", params={"state": q["state"][0], "code": "the-code"}, follow_redirects=False)
    assert back.status_code == 303
    _, data, auth = idp["posts"][-1]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(data["code_verifier"].encode()).digest()).decode().rstrip("=")
    assert challenge == q["code_challenge"][0] and auth == ("terrax-client", "s3cret")  # PKCE: the verifier matches
    return back.headers["location"]


def test_single_sign_on_creates_links_and_refuses(app, idp, monkeypatch):
    c = new_client(app)
    assert c.get("/api/auth/me").json()["sso"] == {"name": "Example ID"}
    fid = sample(c)  # guest work moves into the account
    email = uniq("sso")
    assert _sso(c, idp, sub="u-1", email=email, email_verified=True, name="Ada") == "https://terrax.example.org/?signin=sso"
    me = c.get("/api/auth/me").json()["user"]
    assert me["email"] == email and me["singleSignOn"] and me["emailVerified"]
    assert [f["id"] for f in c.get("/api/files").json()["files"]] == [fid]
    # The same subject signs in to the same account; an SSO-only account has no password to guess.
    d = new_client(app)
    _sso(d, idp, sub="u-1", email=email, email_verified=True)
    assert d.get("/api/auth/me").json()["user"]["id"] == me["id"]
    assert new_client(app).post("/api/auth/login", json={"email": email, "password": "sso-only"}).status_code == 401
    assert me["hasPassword"] is False
    assert d.post("/api/auth/password", json={"current": "", "new": "a new passphrase"}).status_code == 400
    assert d.post("/api/auth/delete-account", json={"password": "wrong@example.org"}).status_code == 401
    assert d.post("/api/auth/delete-account", json={"password": email.upper()}).json() == {"ok": True}
    # A password account is linked when the provider vouches for the address, not otherwise.
    pw_email = uniq("linked")
    uid = signup(new_client(app), pw_email)["user"]["id"]
    e = new_client(app)
    assert "signin_error" in _sso(e, idp, sub="u-2", email=pw_email, email_verified=False)
    assert e.get("/api/auth/me").json()["user"] is None
    _sso(e, idp, sub="u-3", email=pw_email, email_verified=True)
    assert e.get("/api/auth/me").json()["user"]["id"] == uid
    # Domains and account creation can be restricted.
    monkeypatch.setenv("TERRAX_OIDC_DOMAINS", "corp.example")
    assert "domain" in _sso(new_client(app), idp, sub="u-4", email=uniq("outside"), email_verified=True)
    monkeypatch.setenv("TERRAX_OIDC_DOMAINS", "")
    monkeypatch.setenv("TERRAX_OIDC_CREATE_ACCOUNTS", "false")
    assert "administrator" in _sso(new_client(app), idp, sub="u-5", email=uniq("new"), email_verified=True)


@pytest.mark.parametrize(("claims", "problem"), [
    ({"iss": "https://evil.example"}, "issuer"), ({"aud": "someone-else"}, "audience"),
    ({"aud": ["terrax-client", "other"], "azp": "other"}, "audience"), ({"exp": 1000}, "expiry"),
    ({"nonce": "replayed"}, "nonce"), ({"sub": None}, "subject"),
])
def test_single_sign_on_checks_the_id_token(app, idp, claims, problem):
    c = new_client(app)
    where = _sso(c, idp, email=uniq("bad"), email_verified=True, **claims)
    assert problem in parse_qs(urlparse(where).query)["signin_error"][0]
    assert c.get("/api/auth/me").json()["user"] is None


def test_single_sign_on_state_is_single_use(app, idp):
    c = new_client(app)
    r = c.get("/api/auth/oidc/start", follow_redirects=False)
    q = parse_qs(urlparse(r.headers["location"]).query)
    idp["claims"] = {"iss": ISS, "aud": "terrax-client", "exp": time.time() + 300, "nonce": q["nonce"][0], "sub": "once", "email": uniq("once"), "email_verified": True}
    params = {"state": q["state"][0], "code": "c"}
    assert "signin=sso" in c.get("/api/auth/oidc/callback", params=params, follow_redirects=False).headers["location"]
    again = new_client(app).get("/api/auth/oidc/callback", params=params, follow_redirects=False).headers["location"]
    assert "signin_error" in again
    assert "signin_error" in new_client(app).get("/api/auth/oidc/callback", params={"state": "forged", "code": "c"}, follow_redirects=False).headers["location"]


def test_single_sign_on_is_off_without_settings(app):
    assert new_client(app).get("/api/auth/oidc/start", follow_redirects=False).status_code == 404
    assert new_client(app).get("/api/auth/me").json()["sso"] is None


# ── Signed links to pictures and tiles ───────────────────────────────────────


def test_signed_media_links_work_without_cookies_and_expire(app, monkeypatch):
    from terrax import signing

    c = new_client(app)
    fid = sample(c)
    job = c.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": fid}}).json()
    art = job["result"]["layers"]["slope"]
    assert "?t=" in art
    tok = c.get(f"/api/files/{fid}").json()["token"]
    monkeypatch.setenv("TERRAX_AUTH", "required")  # no cookie at all: only the signature lets it through
    cookieless = TestClient(app)
    assert cookieless.get(art).status_code == 200
    assert cookieless.get(art.split("?")[0]).status_code == 401
    other_job = art.replace(job["id"], "0" * 32)
    assert cookieless.get(other_job).status_code == 401  # the signature is bound to the job
    token = parse_qs(urlparse(art).query)["t"][0]
    exp, mac = token.split(".")
    assert cookieless.get(art.replace(token, f"{int(exp) + 3600}.{mac}")).status_code == 401  # a longer expiry breaks it
    assert signing.check("job", job["id"], token) and not signing.check("job", job["id"], f"{int(time.time()) - 1}.{signing._mac('job', job['id'], int(time.time()) - 1)}")
    # A file's composite: the token from the file's description.
    rr = cookieless.get(f"/api/rasters/{fid}/composite.png", params={"bands": "0,0,0", "t": tok})
    assert rr.status_code == 200, (rr.text, tok, signing.check("file", fid, tok))
    assert cookieless.get(f"/api/rasters/{fid}/composite.png", params={"bands": "0,0,0"}).status_code == 401
    # Deleting the job ends its links.
    monkeypatch.setenv("TERRAX_AUTH", "optional")
    assert c.delete(f"/api/jobs/{job['id']}").status_code == 204
    monkeypatch.setenv("TERRAX_AUTH", "required")
    assert cookieless.get(art).status_code == 404
