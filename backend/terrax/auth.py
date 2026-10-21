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


def public_user(u: dict[str, Any]) -> dict[str, Any]:
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "created": u["created"], "lastLogin": u.get("last_login"), "disabled": bool(u["disabled"])}


def get_user(user_id: str) -> dict[str, Any] | None:
    with db.connect() as c:
        return db.row(c.execute(select(db.users).where(db.users.c.id == user_id)).first())


def user_by_email(email: str) -> dict[str, Any] | None:
    with db.connect() as c:
        return db.row(c.execute(select(db.users).where(db.users.c.email == email.strip().lower())).first())


def create_user(email: str, password: str, name: str = "", role: str = "user") -> dict[str, Any]:
    email = normalise_email(email)
    check_new_password(password, email)
    if role not in ("user", "admin"):
        raise HTTPException(400, "A role is user or admin.")
    with db.connect() as c:
        if c.execute(select(db.users.c.id).where(db.users.c.email == email)).first():
            raise HTTPException(409, "An account with this e-mail already exists.")
        u = {"id": secrets.token_hex(16), "email": email, "name": name.strip()[:120], "password_hash": hash_password(password), "role": role, "disabled": False, "created": time.time(), "last_login": None}
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
        create_user(s.admin_email, s.admin_password, "Administrator", "admin")
        return
    if not verify_password(s.admin_password, u["password_hash"]) or u["role"] != "admin" or u["disabled"]:
        with db.connect() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(password_hash=hash_password(s.admin_password), role="admin", disabled=False))


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
    return {k: m[k] for k in ("id", "email", "name", "role", "disabled", "created", "last_login", "password_hash")}


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
        if len(hops) >= n:
            return hops[-n]
    return request.client.host if request.client else ""


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


def principal(request: Request) -> Principal:
    """FastAPI dependency: the caller, or 401 when this server needs a sign-in."""
    p: Principal | None = getattr(request.state, "principal", None)
    if p is None:
        raise HTTPException(401, "Sign in to use TerraX on this server.")
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


def claim_guest_data(guest_token: str, user_id: str) -> int:
    """On sign-in, the uploads and jobs this browser made as a guest become the user's."""
    g = guest_owner(guest_token)
    owner = f"u:{user_id}"
    keep = settings().user_retention_days
    with db.connect() as c:
        n = 0
        expires = time.time() + keep * 86400 if keep else None
        for t in (db.files, db.jobs):
            n += c.execute(update(t).where(t.c.owner == g, t.c.purged.is_(False)).values(owner=owner, expires=expires)).rowcount or 0
    return n
