"""Who is asking: accounts, sign-in sessions and guests, and who may see what.

Every request has a principal. A signed-in user owns ``u:<user id>``. A guest (TERRAX_AUTH off or optional) gets a
random cookie, and owns ``g:<hash of it>``: their uploads and jobs are invisible to everyone else, so a leaked job
link is not enough to read a result. With TERRAX_AUTH=required there are no guests.

Passwords are hashed with scrypt (RFC 7914) at N = 2¹⁵, r = 8, p = 3, one of OWASP's recommended settings (32 MiB per
hash), with a random 16-byte salt; the parameters are stored with the hash so they can be raised later. Session
tokens are 32 random bytes; the database keeps only their SHA-256, so a copy of the database cannot be replayed.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request, Response
from sqlalchemy import delete, func, select, update

from . import db
from .config import settings

SESSION_COOKIE = "terrax_session"
GUEST_COOKIE = "terrax_guest"
_SCRYPT = {"n": 2**15, "r": 8, "p": 3}
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s.]{2,}$")
MIN_PASSWORD = 8  # NIST SP 800-63B: at least 8 characters, no composition rules, long passphrases allowed
MAX_PASSWORD = 256


# ── Passwords ────────────────────────────────────────────────────────────────


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=256 * 1024 * 1024, dklen=32)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = _scrypt(password, salt, **_SCRYPT)
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${b64(salt)}${b64(key)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, key = stored.split("$")
        if algo != "scrypt":
            return False
        got = _scrypt(password, base64.b64decode(salt), int(n), int(r), int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, base64.b64decode(key))


_DUMMY_HASH: str | None = None


def _equalise_timing(password: str) -> None:
    """Hashes against a throwaway hash, so a wrong e-mail takes as long as a wrong password."""
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_urlsafe(12))
    verify_password(password, _DUMMY_HASH)


def check_new_password(password: str, email: str = "") -> None:
    if len(password) < MIN_PASSWORD:
        raise HTTPException(400, f"Use a password of at least {MIN_PASSWORD} characters (a few words is easiest to remember).")
    if len(password) > MAX_PASSWORD:
        raise HTTPException(400, f"Use a password of at most {MAX_PASSWORD} characters.")
    if email and password.strip().lower() == email.strip().lower():
        raise HTTPException(400, "Use a password that is not your e-mail address.")


def normalise_email(email: str) -> str:
    e = email.strip().lower()
    if not _EMAIL.match(e):
        raise HTTPException(400, "Enter a valid e-mail address.")
    return e


# ── Users ────────────────────────────────────────────────────────────────────


#: The stored "hash" of an account without a password: no scrypt string, so no password ever matches it.
NO_PASSWORD = "sso-only"


def public_user(u: dict[str, Any]) -> dict[str, Any]:
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "created": u["created"], "lastLogin": u.get("last_login"), "disabled": bool(u["disabled"]),
            "emailVerified": bool(u.get("email_verified")), "twoFactor": bool(u.get("totp_enabled")), "singleSignOn": bool(u.get("oidc_sub")),
            "hasPassword": has_password(u)}


def has_password(u: dict[str, Any]) -> bool:
    """False for an account made by single sign-on that never set a password (it can, through a reset link)."""
    return u.get("password_hash") != NO_PASSWORD


def get_user(user_id: str) -> dict[str, Any] | None:
    with db.connect() as c:
        return db.row(c.execute(select(db.users).where(db.users.c.id == user_id)).first())


def user_by_email(email: str) -> dict[str, Any] | None:
    with db.connect() as c:
        return db.row(c.execute(select(db.users).where(db.users.c.email == email.strip().lower())).first())


def create_user(email: str, password: str | None, name: str = "", role: str = "user", verified: bool = False, oidc_sub: str | None = None) -> dict[str, Any]:
    """A new account. password None: single sign-on only (a random, unusable password until one is set by reset)."""
    email = normalise_email(email)
    if password is not None:
        check_new_password(password, email)
    if role not in ("user", "admin"):
        raise HTTPException(400, "A role is user or admin.")
    with db.connect() as c:
        if c.execute(select(db.users.c.id).where(db.users.c.email == email)).first():
            raise HTTPException(409, "An account with this e-mail already exists.")
        u = {"id": secrets.token_hex(16), "email": email, "name": name.strip()[:120], "password_hash": hash_password(password) if password is not None else NO_PASSWORD,
             "role": role, "disabled": False, "created": time.time(), "last_login": None, "email_verified": verified, "oidc_sub": oidc_sub, "totp_secret": None,
             "totp_enabled": False, "totp_last_step": None}
        c.execute(db.users.insert().values(**u))
    return u


def set_password(user_id: str, password: str) -> None:
    u = get_user(user_id)
    if not u:
        raise KeyError(user_id)
    check_new_password(password, u["email"])
    with db.connect() as c:
        c.execute(update(db.users).where(db.users.c.id == user_id).values(password_hash=hash_password(password)))
        c.execute(delete(db.sessions).where(db.sessions.c.user_id == user_id))  # signs out everywhere


def count_admins() -> int:
    with db.connect() as c:
        return int(c.execute(select(func.count()).select_from(db.users).where(db.users.c.role == "admin", db.users.c.disabled.is_(False))).scalar_one())


def ensure_admin() -> None:
    """Creates the TERRAX_ADMIN_EMAIL account (or resets it to TERRAX_ADMIN_PASSWORD and the admin role)."""
    s = settings()
    if not s.admin_email or not s.admin_password:
        return
    u = user_by_email(s.admin_email)
    if u is None:
        create_user(s.admin_email, s.admin_password, "Administrator", "admin", verified=True)
        return
    if not verify_password(s.admin_password, u["password_hash"]) or u["role"] != "admin" or u["disabled"]:
        with db.connect() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(password_hash=hash_password(s.admin_password), role="admin", disabled=False, email_verified=True))


# ── Sessions ─────────────────────────────────────────────────────────────────


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def start_session(user_id: str, ip: str, user_agent: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db.connect() as c:
        c.execute(db.sessions.insert().values(token_hash=_digest(token), user_id=user_id, created=now, expires=now + settings().session_days * 86400,
                                              last_seen=now, ip=ip[:64], user_agent=user_agent[:300]))
        c.execute(update(db.users).where(db.users.c.id == user_id).values(last_login=now))
        c.execute(delete(db.sessions).where(db.sessions.c.expires < now))
    return token


def end_session(token: str) -> None:
    with db.connect() as c:
        c.execute(delete(db.sessions).where(db.sessions.c.token_hash == _digest(token)))


def session_user(token: str) -> dict[str, Any] | None:
    """The enabled user of a live session, sliding its expiry forward (at most once an hour)."""
    now = time.time()
    h = _digest(token)
    with db.connect() as c:
        r = c.execute(select(db.sessions, db.users).join(db.users, db.users.c.id == db.sessions.c.user_id).where(db.sessions.c.token_hash == h)).first()
        if r is None:
            return None
        m = dict(r._mapping)
        if m["expires"] < now or m["disabled"]:
            c.execute(delete(db.sessions).where(db.sessions.c.token_hash == h))
            return None
        if now - m["last_seen"] > 3600:
            c.execute(update(db.sessions).where(db.sessions.c.token_hash == h).values(last_seen=now, expires=now + settings().session_days * 86400))
    return {k: m[k] for k in ("id", "email", "name", "role", "disabled", "created", "last_login", "password_hash", "email_verified", "oidc_sub", "totp_secret",
                              "totp_enabled", "totp_last_step")} | {"session_id": h[:16]}


def session_id(token: str) -> str:
    """A session's public id: the first 16 hex digits of its stored hash (the token stays secret)."""
    return _digest(token)[:16]


def list_sessions(user_id: str) -> list[dict[str, Any]]:
    now = time.time()
    with db.connect() as c:
        rows = c.execute(select(db.sessions).where(db.sessions.c.user_id == user_id, db.sessions.c.expires > now).order_by(db.sessions.c.last_seen.desc())).all()
    return [{"id": r.token_hash[:16], "created": r.created, "lastSeen": r.last_seen, "expires": r.expires, "ip": r.ip, "userAgent": r.user_agent} for r in rows]


def end_sessions(user_id: str, sid: str | None = None, keep: str | None = None) -> int:
    """Ends one session of a user (by public id), or all of them but `keep`; returns how many."""
    with db.connect() as c:
        q = delete(db.sessions).where(db.sessions.c.user_id == user_id)
        if sid is not None:
            q = q.where(db.sessions.c.token_hash.startswith(sid))
        if keep is not None:
            q = q.where(~db.sessions.c.token_hash.startswith(keep))
        return int(c.execute(q).rowcount or 0)


# ── One-time links (password reset, address confirmation) ───────────────────

TOKEN_TTL = {"reset": 3600, "verify": 2 * 86400}


def issue_token(user_id: str, purpose: str) -> str:
    """A single-use token; issuing a new one cancels the user's unused ones for the same purpose."""
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db.connect() as c:
        c.execute(delete(db.tokens).where(db.tokens.c.user_id == user_id, db.tokens.c.purpose == purpose, db.tokens.c.used.is_(None)))
        c.execute(db.tokens.insert().values(token_hash=_digest(token), user_id=user_id, purpose=purpose, created=now, expires=now + TOKEN_TTL[purpose], used=None))
        c.execute(delete(db.tokens).where(db.tokens.c.expires < now - 86400))
    return token


def use_token(token: str, purpose: str) -> str | None:
    """The user a live, unused token belongs to (marking it used), or None."""
    now = time.time()
    h = _digest(token)
    with db.connect() as c:
        r = c.execute(select(db.tokens).where(db.tokens.c.token_hash == h, db.tokens.c.purpose == purpose)).first()
        if r is None or r.used is not None or r.expires < now:
            return None
        n = c.execute(update(db.tokens).where(db.tokens.c.token_hash == h, db.tokens.c.used.is_(None)).values(used=now)).rowcount
    return str(r.user_id) if n else None  # n == 0: another request used it a moment earlier


def public_base_url(request: Request) -> str:
    """Where people open TerraX: TERRAX_PUBLIC_URL, else this request's scheme and host (forwarded ones behind trusted proxies)."""
    s = settings()
    if s.public_url:
        return s.public_url
    host = request.headers.get("host", "")
    if s.trusted_proxies and request.headers.get("x-forwarded-host"):
        host = request.headers["x-forwarded-host"].split(",")[0].strip()
    return f"{'https' if is_https(request) else 'http'}://{host}"


# ── Principals ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Principal:
    owner: str
    user: dict[str, Any] | None = None

    @property
    def user_id(self) -> str | None:
        return self.user["id"] if self.user else None

    @property
    def is_admin(self) -> bool:
        return bool(self.user and self.user["role"] == "admin")

    @property
    def is_guest(self) -> bool:
        return self.user is None


def guest_owner(token: str) -> str:
    return "g:" + _digest(token)[:40]


def client_ip(request: Request) -> str:
    """The client's address: the socket's, or the right-most untrusted X-Forwarded-For entry behind trusted proxies."""
    n = settings().trusted_proxies
    if n:
        hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
        if len(hops) >= n and _is_ip(hops[-n]):
            return hops[-n]
        # Fewer hops than configured (a request that skipped a proxy): the raw socket address, never a claimed one.
        peer = request.scope.get("client")
        return str(peer[0]) if peer else ""
    return request.client.host if request.client else ""


def _is_ip(v: str) -> bool:
    import ipaddress

    try:
        ipaddress.ip_address(v)
        return True
    except ValueError:
        return False


def is_https(request: Request) -> bool:
    if settings().trusted_proxies and request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https":
        return True
    return request.url.scheme == "https"


def secure_cookies(request: Request) -> bool:
    if settings().cookie_samesite == "none":
        return True  # browsers drop SameSite=None cookies that are not Secure
    v = settings().cookie_secure
    return is_https(request) if v == "auto" else v in ("1", "true", "yes", "on")


def set_cookie(response: Response, request: Request, name: str, value: str, max_age: int) -> None:
    """An HttpOnly cookie for the whole site (max_age 0 clears it, with the same attributes so browsers match it)."""
    embedded = settings().cookie_samesite == "none"
    response.set_cookie(name, value, max_age=max_age, httponly=True, samesite="none" if embedded else "lax", secure=secure_cookies(request), path="/")
    if embedded:
        # CHIPS: a cookie kept per top-level site, which browsers allow in third-party frames. Added by hand because
        # Python's http.cookies only knows the attribute from 3.14 on.
        prefix = f"{name}=".encode()
        for i in range(len(response.raw_headers) - 1, -1, -1):
            k, v = response.raw_headers[i]
            if k == b"set-cookie" and v.startswith(prefix):
                response.raw_headers[i] = (k, v + b"; Partitioned")
                break


def clear_cookie(response: Response, request: Request, name: str) -> None:
    set_cookie(response, request, name, "", 0)


def resolve(request: Request) -> tuple[Principal | None, str | None]:
    """The request's principal, and a new guest token to set as a cookie (or None)."""
    token = request.cookies.get(SESSION_COOKIE) or ""
    auth = request.headers.get("authorization", "")
    if not token and auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    if token:
        u = session_user(token)
        if u:
            return Principal(owner=f"u:{u['id']}", user=u), None
    if settings().auth_mode == "required":
        return None, None
    guest = request.cookies.get(GUEST_COOKIE) or ""
    if len(guest) >= 32:
        return Principal(owner=guest_owner(guest)), None
    guest = secrets.token_urlsafe(32)
    return Principal(owner=guest_owner(guest)), guest


def verification_required() -> bool:
    from .mailer import can_send

    return settings().verify_email and can_send()


def principal(request: Request) -> Principal:
    """FastAPI dependency: the caller; 401 when this server needs a sign-in, 403 while an address awaits confirmation."""
    p: Principal | None = getattr(request.state, "principal", None)
    if p is None:
        raise HTTPException(401, "Sign in to use TerraX on this server.")
    if p.user and not p.user.get("email_verified") and verification_required():
        raise HTTPException(403, f"Confirm your e-mail address first: open the link sent to {p.user['email']} (or send a new one from your account).")
    return p


def signed_in(request: Request) -> Principal:
    """A signed-in user, confirmed or not (for the account's own settings and resending the confirmation)."""
    p: Principal | None = getattr(request.state, "principal", None)
    if p is None or p.is_guest:
        raise HTTPException(401, "Sign in first.")
    return p


def require_user(request: Request) -> Principal:
    p = principal(request)
    if p.is_guest:
        raise HTTPException(401, "Sign in to keep projects and history on the server.")
    return p


def require_admin(request: Request) -> Principal:
    p = require_user(request)
    if not p.is_admin:
        raise HTTPException(403, "Only an administrator can do this.")
    return p


# ── Ownership ────────────────────────────────────────────────────────────────


def can_read(p: Principal, owner: str | None) -> bool:
    return owner is not None and (owner == p.owner or p.is_admin)


def own_file(p: Principal, file_id: str) -> None:
    """KeyError (404) unless the caller may use this upload; the same answer as for a file that does not exist."""
    with db.connect() as c:
        r = c.execute(select(db.files.c.owner, db.files.c.purged).where(db.files.c.id == file_id)).first()
    if r is None or r.purged or not can_read(p, r.owner):
        raise KeyError(file_id)


def own_job(p: Principal, job_id: str) -> None:
    with db.connect() as c:
        r = c.execute(select(db.jobs.c.owner, db.jobs.c.purged).where(db.jobs.c.id == job_id)).first()
    if r is None or r.purged or not can_read(p, r.owner):
        raise KeyError(job_id)


def claim_guest_data(guest_token: str, user_id: str, guest: str | None = None) -> int:
    """On sign-in, the uploads and jobs this browser made as a guest (its cookie, or a guest owner id) become the user's."""
    g = guest or guest_owner(guest_token)
    owner = f"u:{user_id}"
    keep = settings().user_retention_days
    with db.connect() as c:
        n = 0
        expires = time.time() + keep * 86400 if keep else None
        for t in (db.files, db.jobs):
            n += c.execute(update(t).where(t.c.owner == g, t.c.purged.is_(False)).values(owner=owner, expires=expires)).rowcount or 0
    return n
