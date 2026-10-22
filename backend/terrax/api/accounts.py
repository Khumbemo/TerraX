"""Accounts and projects kept on the server.

* Sign-up, sign-in (with a two-factor code when it is on), sign-out, password change, deleting the account.
* E-mail: password-reset links and address confirmation (single-use tokens, 1 h and 48 h).
* Two-factor sign-in (TOTP, RFC 6238) with recovery codes; single sign-on (OpenID Connect).
* The account's sessions (devices), each of which can be signed out.
* Projects: the document the web app exports as ``.terrax.json`` (boundary, reports, settings), kept on the server,
  opened on any device and shared with other accounts to read or to edit.

Security events are written to the audit log (terrax.audit).
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select, update

from .. import audit, auth, db, mailer, oidc, ratelimit, storage, totp
from ..auth import Principal, require_user, signed_in
from ..config import settings
from ..monitoring import metrics

router = APIRouter(tags=["accounts"])

#: Largest project document, bytes (reports with figures embedded as pictures can be a few MB).
PROJECT_MAX_BYTES = 25 * 1024 * 1024


def _set_session_cookie(response: Response, request: Request, token: str) -> None:
    auth.set_cookie(response, request, auth.SESSION_COOKIE, token, settings().session_days * 86400)


def _me(request: Request) -> dict[str, Any]:
    p: Principal | None = getattr(request.state, "principal", None)
    s = settings()
    return {"mode": s.auth_mode, "signup": s.signup, "user": auth.public_user(p.user) if p and p.user else None, "guest": bool(p and p.is_guest),
            "mail": mailer.can_send(), "verifyEmail": auth.verification_required(), "sso": {"name": s.oidc_name} if oidc.enabled() else None}


@router.get("/api/auth/me")
def me(request: Request) -> dict[str, Any]:
    """Who is signed in (null for a guest), and how this server handles accounts."""
    return _me(request)


class SignUp(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., max_length=auth.MAX_PASSWORD)
    name: str = Field("", max_length=120)


class SignIn(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., max_length=auth.MAX_PASSWORD)
    #: The authenticator app's 6-digit code, or a recovery code, when two-factor sign-in is on.
    code: str | None = Field(None, max_length=32)


def _signed_in(request: Request, response: Response, user: dict[str, Any], guest_owner: str | None = None) -> dict[str, Any]:
    token = auth.start_session(user["id"], auth.client_ip(request), request.headers.get("user-agent", ""))
    _set_session_cookie(response, request, token)
    guest = request.cookies.get(auth.GUEST_COOKIE) or ""
    claimed = auth.claim_guest_data(guest, user["id"], guest_owner) if (len(guest) >= 32 or guest_owner) else 0
    request.state.principal = Principal(owner=f"u:{user['id']}", user=user)
    return _me(request) | {"claimed": claimed}


def _send_verification(request: Request, user: dict[str, Any]) -> bool:
    """Sends the address-confirmation link; False when the server cannot send mail or the send failed (logged)."""
    if not mailer.can_send():
        return False
    token = auth.issue_token(user["id"], "verify")
    link = mailer.link(f"/?verify={token}")
    try:
        mailer.send(user["email"], "Confirm your TerraX e-mail address",
                    f"Hello{(' ' + user['name']) if user.get('name') else ''},\n\nOpen this link to confirm the address of your TerraX account:\n\n{link}\n\n"
                    "It works for 48 hours. If you did not create an account, ignore this message.\n")
        return True
    except RuntimeError:
        return False


@router.post("/api/auth/signup", status_code=201)
def signup(req: SignUp, request: Request, response: Response) -> dict[str, Any]:
    p: Principal | None = getattr(request.state, "principal", None)
    if settings().signup != "open" and not (p and p.is_admin):
        raise HTTPException(403, "New accounts are created by an administrator on this server.")
    ratelimit.check("signup", auth.client_ip(request))
    by_admin = bool(p and p.is_admin)
    user = auth.create_user(req.email, req.password, req.name, verified=by_admin)
    metrics.count("signups")
    audit.record("auth.signup", request, actor=user, target=user["email"])
    sent = False if by_admin else _send_verification(request, user)
    return _signed_in(request, response, user) | {"verificationSent": sent}


@router.post("/api/auth/login")
def login(req: SignIn, request: Request, response: Response) -> dict[str, Any]:
    email = req.email.strip().lower()
    ratelimit.check("login", auth.client_ip(request), f"email:{email}")
    user = auth.user_by_email(email)
    if user is None:
        auth._equalise_timing(req.password)
    ok = user is not None and auth.verify_password(req.password, user["password_hash"]) and not user["disabled"]
    if not ok:
        metrics.count("login_failures")
        audit.record("auth.login_failed", request, actor=user if user else None, target=email, detail={"reason": "disabled" if user and user["disabled"] else "password"})
        raise HTTPException(401, "The e-mail or password is not right.")
    assert user is not None
    if user.get("totp_enabled"):
        if not req.code:
            return {"twoFactor": True}  # the password was right: ask for the code (no session yet)
        if not _second_factor(user, req.code):
            metrics.count("login_failures")
            audit.record("auth.login_failed", request, actor=user, target=email, detail={"reason": "two-factor code"})
            raise HTTPException(401, "The code is not right (or was already used). Use the newest code from your app, or a recovery code.")
    metrics.count("logins")
    audit.record("auth.login", request, actor=user, target=email, detail={"method": "password" + (" + code" if user.get("totp_enabled") else "")})
    return _signed_in(request, response, user)


def _second_factor(user: dict[str, Any], code: str) -> bool:
    """An authenticator code newer than the last one used, or an unused recovery code (spent on use)."""
    if user.get("totp_secret"):
        stp = totp.match(user["totp_secret"], code, user.get("totp_last_step"))
        if stp is not None:
            with db.connect() as c:
                n = c.execute(update(db.users).where(db.users.c.id == user["id"], or_(db.users.c.totp_last_step.is_(None), db.users.c.totp_last_step < stp))
                              .values(totp_last_step=stp)).rowcount
            return bool(n)  # 0: the same code raced in twice
    h = totp.hash_code(code)
    with db.connect() as c:
        n = c.execute(update(db.recovery_codes).where(db.recovery_codes.c.user_id == user["id"], db.recovery_codes.c.code_hash == h, db.recovery_codes.c.used.is_(None))
                      .values(used=time.time())).rowcount
    return bool(n)


@router.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict[str, Any]:
    token = request.cookies.get(auth.SESSION_COOKIE)
    if token:
        p: Principal | None = getattr(request.state, "principal", None)
        if p and p.user:
            audit.record("auth.logout", request)
        auth.end_session(token)
    auth.clear_cookie(response, request, auth.SESSION_COOKIE)
    return {"ok": True}


class PasswordChange(BaseModel):
    current: str = Field(..., max_length=auth.MAX_PASSWORD)
    new: str = Field(..., max_length=auth.MAX_PASSWORD)


@router.post("/api/auth/password")
def change_password(req: PasswordChange, request: Request, response: Response, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    assert p.user is not None
    ratelimit.check("login", auth.client_ip(request), f"email:{p.user['email']}")
    if not auth.has_password(p.user):
        raise HTTPException(400, "This account signs in with single sign-on and has no password yet. To add one, use “Forgot password” on the sign-in form.")
    if not auth.verify_password(req.current, p.user["password_hash"]):
        raise HTTPException(401, "The current password is not right.")
    auth.set_password(p.user["id"], req.new)  # ends every session, this one included
    audit.record("auth.password_changed", request, target=p.user["email"])
    return _signed_in(request, response, auth.get_user(p.user["id"]) or p.user)


class DeleteAccount(BaseModel):
    #: The password; for an account without one (single sign-on), its e-mail address, typed to confirm.
    password: str = Field(..., max_length=auth.MAX_PASSWORD)


def _confirms(user: dict[str, Any], password: str) -> bool:
    if auth.has_password(user):
        return auth.verify_password(password, user["password_hash"])
    return password.strip().lower() == user["email"]


@router.post("/api/auth/delete-account")
def delete_account(req: DeleteAccount, request: Request, response: Response, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    """Deletes the account, its sessions, projects, uploads, results and history."""
    assert p.user is not None
    if not _confirms(p.user, req.password):
        raise HTTPException(401, "The password is not right." if auth.has_password(p.user) else "Type the account's e-mail address to confirm.")
    if p.is_admin and auth.count_admins() <= 1:
        raise HTTPException(400, "This is the only administrator; make another account an administrator first.")
    purge_owner_data(p.owner)
    with db.connect() as c:
        c.execute(delete(db.users).where(db.users.c.id == p.user["id"]))
    audit.record("auth.account_deleted", request, target=p.user["email"])
    auth.clear_cookie(response, request, auth.SESSION_COOKIE)
    return {"ok": True}


# ── Sessions (devices) ───────────────────────────────────────────────────────


@router.get("/api/auth/sessions")
def sessions(request: Request, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    """The account's live sign-ins, newest use first; "current" is this one."""
    assert p.user is not None
    current = p.user.get("session_id")
    return {"sessions": [s | {"current": s["id"] == current} for s in auth.list_sessions(p.user["id"])]}


@router.delete("/api/auth/sessions/{sid}", status_code=204)
def end_session(sid: str, request: Request, response: Response, p: Principal = Depends(signed_in)) -> Response:
    assert p.user is not None
    if len(sid) != 16 or any(ch not in "0123456789abcdef" for ch in sid):
        raise KeyError(sid)
    if not auth.end_sessions(p.user["id"], sid=sid):
        raise KeyError(sid)
    audit.record("auth.session_ended", request, target=p.user["email"], detail={"session": sid})
    return Response(status_code=204)


@router.post("/api/auth/sessions/end-others")
def end_other_sessions(request: Request, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    assert p.user is not None
    n = auth.end_sessions(p.user["id"], keep=p.user.get("session_id"))
    audit.record("auth.sessions_ended", request, target=p.user["email"], detail={"count": n})
    return {"ended": n}


# ── E-mail: password reset and address confirmation ──────────────────────────


class Forgot(BaseModel):
    email: str = Field(..., max_length=254)


class ResetIn(BaseModel):
    token: str = Field(..., max_length=200)
    password: str = Field(..., max_length=auth.MAX_PASSWORD)


class TokenIn(BaseModel):
    token: str = Field(..., max_length=200)


@router.post("/api/auth/forgot")
def forgot(req: Forgot, request: Request) -> dict[str, Any]:
    """Sends a reset link if the account exists; the answer is the same either way (no account discovery)."""
    if not mailer.can_send():
        raise HTTPException(503, "This server cannot send e-mail; ask an administrator to set a new password for you.")
    email = req.email.strip().lower()
    ratelimit.check("mail", auth.client_ip(request), f"email:{email}")
    user = auth.user_by_email(email)
    if user and not user["disabled"]:
        token = auth.issue_token(user["id"], "reset")
        link = mailer.link(f"/?reset={token}")
        try:
            mailer.send(user["email"], "Reset your TerraX password",
                        f"Someone (hopefully you) asked to reset the password of the TerraX account {user['email']}.\n\nOpen this link to choose a new one:\n\n{link}\n\n"
                        "It works once, for one hour. If you did not ask, ignore this message: your password stays as it is.\n")
        except RuntimeError:
            pass  # logged by the mailer; the answer must not reveal whether the account exists
        audit.record("auth.reset_requested", request, actor=user, target=email)
    return {"ok": True}


@router.post("/api/auth/reset")
def reset(req: ResetIn, request: Request) -> dict[str, Any]:
    ratelimit.check("mail", auth.client_ip(request))
    uid = auth.use_token(req.token, "reset")
    user = auth.get_user(uid) if uid else None
    if user is None or user["disabled"]:
        raise HTTPException(400, "This reset link is not valid any more (it works once, for one hour). Ask for a new one.")
    auth.set_password(user["id"], req.password)  # also signs the account out everywhere
    with db.connect() as c:  # opening the link proved the mailbox is theirs
        c.execute(update(db.users).where(db.users.c.id == user["id"]).values(email_verified=True))
    audit.record("auth.password_reset", request, actor=user, target=user["email"])
    return {"ok": True, "email": user["email"]}


@router.post("/api/auth/verify")
def verify(req: TokenIn, request: Request) -> dict[str, Any]:
    uid = auth.use_token(req.token, "verify")
    user = auth.get_user(uid) if uid else None
    if user is None:
        raise HTTPException(400, "This confirmation link is not valid any more (it works once, for 48 hours). Send a new one from your account.")
    with db.connect() as c:
        c.execute(update(db.users).where(db.users.c.id == user["id"]).values(email_verified=True))
    audit.record("auth.email_verified", request, actor=user, target=user["email"])
    return {"ok": True, "email": user["email"]}


@router.post("/api/auth/verify/resend")
def resend_verification(request: Request, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    assert p.user is not None
    if p.user.get("email_verified"):
        return {"sent": False, "verified": True}
    if not mailer.can_send():
        raise HTTPException(503, "This server cannot send e-mail.")
    ratelimit.check("mail", auth.client_ip(request), f"email:{p.user['email']}")
    if not _send_verification(request, p.user):
        raise HTTPException(502, "The e-mail could not be sent; try again later.")
    return {"sent": True}


# ── Two-factor sign-in (TOTP) ────────────────────────────────────────────────


class CodeIn(BaseModel):
    code: str = Field(..., max_length=32)


class DisableTwoFactor(BaseModel):
    password: str = Field(..., max_length=auth.MAX_PASSWORD)
    code: str = Field(..., max_length=32)


def _new_recovery_codes(user_id: str) -> list[str]:
    codes = totp.recovery_codes()
    with db.connect() as c:
        c.execute(delete(db.recovery_codes).where(db.recovery_codes.c.user_id == user_id))
        c.execute(db.recovery_codes.insert(), [{"user_id": user_id, "code_hash": totp.hash_code(x), "used": None} for x in codes])
    return codes


@router.post("/api/auth/2fa/setup")
def two_factor_setup(request: Request, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    """A new secret to add to an authenticator app; two-factor sign-in turns on once a code from it is confirmed."""
    assert p.user is not None
    if p.user.get("totp_enabled"):
        raise HTTPException(400, "Two-factor sign-in is already on. Turn it off first to set up a new app.")
    secret = totp.new_secret()
    with db.connect() as c:
        c.execute(update(db.users).where(db.users.c.id == p.user["id"]).values(totp_secret=secret, totp_last_step=None))
    return {"secret": secret, "uri": totp.uri(secret, p.user["email"])}


@router.post("/api/auth/2fa/enable")
def two_factor_enable(req: CodeIn, request: Request, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    assert p.user is not None
    ratelimit.check("login", auth.client_ip(request), f"email:{p.user['email']}")
    secret = p.user.get("totp_secret")
    stp = totp.match(secret, req.code, None) if secret else None
    if stp is None:
        raise HTTPException(400, "That code does not match. Check the phone's time is right, and use the newest code.")
    with db.connect() as c:
        c.execute(update(db.users).where(db.users.c.id == p.user["id"]).values(totp_enabled=True, totp_last_step=stp))
    codes = _new_recovery_codes(p.user["id"])
    audit.record("auth.2fa_enabled", request, target=p.user["email"])
    return {"enabled": True, "recoveryCodes": codes}


@router.post("/api/auth/2fa/disable")
def two_factor_disable(req: DisableTwoFactor, request: Request, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    assert p.user is not None
    ratelimit.check("login", auth.client_ip(request), f"email:{p.user['email']}")
    if not _confirms(p.user, req.password) or not _second_factor(p.user, req.code):
        raise HTTPException(401, "The password or code is not right." if auth.has_password(p.user) else "The e-mail address or code is not right.")
    with db.connect() as c:
        c.execute(update(db.users).where(db.users.c.id == p.user["id"]).values(totp_enabled=False, totp_secret=None, totp_last_step=None))
        c.execute(delete(db.recovery_codes).where(db.recovery_codes.c.user_id == p.user["id"]))
    audit.record("auth.2fa_disabled", request, target=p.user["email"])
    return {"enabled": False}


@router.post("/api/auth/2fa/recovery-codes")
def two_factor_new_codes(req: CodeIn, request: Request, p: Principal = Depends(signed_in)) -> dict[str, Any]:
    assert p.user is not None
    ratelimit.check("login", auth.client_ip(request), f"email:{p.user['email']}")
    if not p.user.get("totp_enabled") or not _second_factor(p.user, req.code):
        raise HTTPException(401, "The code is not right.")
    codes = _new_recovery_codes(p.user["id"])
    audit.record("auth.2fa_recovery_codes", request, target=p.user["email"])
    return {"recoveryCodes": codes}


# ── Single sign-on (OpenID Connect) ──────────────────────────────────────────


def _redirect_uri(request: Request) -> str:
    return f"{auth.public_base_url(request)}/api/auth/oidc/callback"


def _back(request: Request, **params: str) -> RedirectResponse:
    from urllib.parse import urlencode

    return RedirectResponse(f"{auth.public_base_url(request)}/?{urlencode(params)}", status_code=303)


@router.get("/api/auth/oidc/start")
def oidc_start(request: Request) -> RedirectResponse:
    if not oidc.enabled():
        raise HTTPException(404, "Single sign-on is not set up on this server.")
    ratelimit.check("login", auth.client_ip(request))
    try:
        state, nonce, verifier = oidc.new_flow()
        url = oidc.authorization_url(_redirect_uri(request), state, nonce, verifier)
    except Exception as err:  # discovery failed: the provider is down or misconfigured
        return _back(request, signin_error=f"The sign-in provider could not be reached ({type(err).__name__}).")
    p: Principal | None = getattr(request.state, "principal", None)
    now = time.time()
    with db.connect() as c:
        c.execute(delete(db.oidc_states).where(db.oidc_states.c.created < now - oidc.STATE_SECONDS))
        c.execute(db.oidc_states.insert().values(state_hash=auth._digest(state), nonce=nonce, verifier=verifier, guest=p.owner if p and p.is_guest else "", created=now))
    return RedirectResponse(url, status_code=303)


@router.get("/api/auth/oidc/callback")
def oidc_callback(request: Request, state: str = Query("", max_length=200), code: str = Query("", max_length=4000), error: str = Query("", max_length=200)) -> RedirectResponse:
    if not oidc.enabled():
        raise HTTPException(404, "Single sign-on is not set up on this server.")
    with db.connect() as c:
        row = db.row(c.execute(select(db.oidc_states).where(db.oidc_states.c.state_hash == auth._digest(state))).first()) if state else None
        if row:
            c.execute(delete(db.oidc_states).where(db.oidc_states.c.state_hash == row["state_hash"]))  # single use
    if error:
        return _back(request, signin_error=f"The sign-in provider said: {error}.")
    if not row or row["created"] < time.time() - oidc.STATE_SECONDS or not code:
        return _back(request, signin_error="That sign-in took too long or did not start here. Try again.")
    try:
        ident = oidc.finish(code, _redirect_uri(request), row["nonce"], row["verifier"])
    except Exception as err:
        audit.record("auth.login_failed", request, detail={"method": "sso", "reason": str(err)[:200]})
        return _back(request, signin_error=str(err) if isinstance(err, ValueError) else "The sign-in could not be completed.")
    user = _sso_account(ident)
    if isinstance(user, str):
        audit.record("auth.login_failed", request, target=ident.get("email", ""), detail={"method": "sso", "reason": user})
        return _back(request, signin_error=user)
    response = _back(request, signin="sso")
    _signed_in(request, response, user, guest_owner=row["guest"] or None)
    metrics.count("logins")
    audit.record("auth.login", request, actor=user, target=user["email"], detail={"method": "sso"})
    return response


def _sso_account(ident: dict[str, Any]) -> dict[str, Any] | str:
    """The account for a single-sign-on identity: linked by subject, else by verified e-mail, else new; or why not."""
    s = settings()
    email = ident["email"]
    if s.oidc_domains and email.rsplit("@", 1)[-1] not in s.oidc_domains:
        return "Accounts from this e-mail domain cannot sign in here."
    with db.connect() as c:
        u = db.row(c.execute(select(db.users).where(db.users.c.oidc_sub == ident["sub"])).first())
    if u is None and email and ident["email_verified"]:
        u = auth.user_by_email(email)
        if u is not None:
            with db.connect() as c:
                c.execute(update(db.users).where(db.users.c.id == u["id"]).values(oidc_sub=ident["sub"], email_verified=True))
            u = auth.get_user(u["id"])
    if u is None:
        if not email or not ident["email_verified"]:
            return "The sign-in provider did not give a verified e-mail address."
        if not s.oidc_create_accounts or s.signup != "open":
            return "There is no TerraX account for this e-mail; ask an administrator to create one."
        u = auth.create_user(email, None, ident.get("name", ""), verified=True, oidc_sub=ident["sub"])
    if u["disabled"]:
        return "This account is disabled."
    return u


def purge_owner_data(owner: str) -> None:
    """Every upload and job of an owner, with its files on disk."""
    with db.connect() as c:
        fids = [r[0] for r in c.execute(select(db.files.c.id).where(db.files.c.owner == owner))]
        jids = [r[0] for r in c.execute(select(db.jobs.c.id).where(db.jobs.c.owner == owner))]
    for f in fids:
        storage.delete_file(f)
    for j in jids:
        storage.delete_job(j)
    with db.connect() as c:
        c.execute(delete(db.files).where(db.files.c.owner == owner))


# ── Projects ─────────────────────────────────────────────────────────────────


class ProjectIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    data: dict[str, Any]


class ProjectPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    data: dict[str, Any] | None = None


class ShareIn(BaseModel):
    email: str = Field(..., max_length=254)
    canEdit: bool = False


def _clean(data: dict[str, Any]) -> dict[str, Any]:
    from ..signing import strip_tokens

    return strip_tokens(data)


def _check_size(data: dict[str, Any]) -> None:
    if len(json.dumps(data, separators=(",", ":"))) > PROJECT_MAX_BYTES:
        raise HTTPException(413, f"The project is larger than {PROJECT_MAX_BYTES // (1024 * 1024)} MB; remove some saved reports or their figures.")


def _access(p: Principal, project_id: str) -> tuple[dict[str, Any], str]:
    """The project and the caller's access to it ("owner", "edit" or "read"); 404 when they have none."""
    uid = p.user_id
    with db.connect() as c:
        pr = db.row(c.execute(select(db.projects).where(db.projects.c.id == project_id)).first())
        if pr is None:
            raise KeyError(project_id)
        if pr["owner"] == uid:
            return pr, "owner"
        sh = c.execute(select(db.project_shares.c.can_edit).where(db.project_shares.c.project_id == project_id, db.project_shares.c.user_id == uid)).first()
    if sh is not None:
        return pr, "edit" if sh.can_edit else "read"
    if p.is_admin:
        return pr, "read"
    raise KeyError(project_id)


def _summary(pr: dict[str, Any], access: str, owner_email: str | None = None) -> dict[str, Any]:
    return {"id": pr["id"], "name": pr["name"], "created": pr["created"], "updated": pr["updated"], "access": access, "ownerEmail": owner_email}


@router.get("/api/projects")
def list_projects(p: Principal = Depends(require_user)) -> dict[str, Any]:
    uid = p.user_id
    with db.connect() as c:
        shared = select(db.project_shares.c.project_id).where(db.project_shares.c.user_id == uid)
        rows = c.execute(select(db.projects.c.id, db.projects.c.name, db.projects.c.created, db.projects.c.updated, db.projects.c.owner, db.users.c.email)
                         .join(db.users, db.users.c.id == db.projects.c.owner)
                         .where(or_(db.projects.c.owner == uid, db.projects.c.id.in_(shared))).order_by(db.projects.c.updated.desc())).all()
        edits = {r.project_id: r.can_edit for r in c.execute(select(db.project_shares).where(db.project_shares.c.user_id == uid))}
    out = []
    for r in rows:
        access = "owner" if r.owner == uid else "edit" if edits.get(r.id) else "read"
        out.append(_summary(dict(r._mapping), access, None if access == "owner" else r.email))
    return {"projects": out}


@router.post("/api/projects", status_code=201)
def create_project(req: ProjectIn, p: Principal = Depends(require_user)) -> dict[str, Any]:
    _check_size(req.data)
    now = time.time()
    pr = {"id": secrets.token_hex(16), "owner": p.user_id, "name": req.name.strip(), "data": _clean(req.data), "created": now, "updated": now}
    with db.connect() as c:
        c.execute(db.projects.insert().values(**pr))
    return _summary(pr, "owner")


@router.get("/api/projects/{project_id}")
def get_project(project_id: str, p: Principal = Depends(require_user)) -> dict[str, Any]:
    pr, access = _access(p, project_id)
    out = _summary(pr, access) | {"data": pr["data"]}
    if access == "owner":
        with db.connect() as c:
            out["shares"] = [{"userId": r.user_id, "email": r.email, "canEdit": bool(r.can_edit)} for r in c.execute(
                select(db.project_shares.c.user_id, db.project_shares.c.can_edit, db.users.c.email).join(db.users, db.users.c.id == db.project_shares.c.user_id)
                .where(db.project_shares.c.project_id == project_id))]
    return out


@router.put("/api/projects/{project_id}")
def update_project(project_id: str, req: ProjectPatch, p: Principal = Depends(require_user)) -> dict[str, Any]:
    pr, access = _access(p, project_id)
    if access not in ("owner", "edit"):
        raise HTTPException(403, "This project is shared with you to read only.")
    values: dict[str, Any] = {"updated": time.time()}
    if req.name is not None:
        values["name"] = req.name.strip()
    if req.data is not None:
        _check_size(req.data)
        values["data"] = _clean(req.data)
    with db.connect() as c:
        c.execute(update(db.projects).where(db.projects.c.id == project_id).values(**values))
    return _summary(pr | values, access)


@router.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str, p: Principal = Depends(require_user)) -> Response:
    _, access = _access(p, project_id)
    if access != "owner":
        raise HTTPException(403, "Only the project's owner can delete it.")
    with db.connect() as c:
        c.execute(delete(db.projects).where(db.projects.c.id == project_id))
    return Response(status_code=204)


@router.post("/api/projects/{project_id}/shares", status_code=201)
def share_project(project_id: str, req: ShareIn, p: Principal = Depends(require_user)) -> dict[str, Any]:
    _, access = _access(p, project_id)
    if access != "owner":
        raise HTTPException(403, "Only the project's owner can share it.")
    other = auth.user_by_email(req.email)
    if other is None or other["disabled"]:
        raise HTTPException(404, "There is no account with this e-mail on this server.")
    if other["id"] == p.user_id:
        raise HTTPException(400, "This is your own project.")
    with db.connect() as c:
        c.execute(delete(db.project_shares).where(db.project_shares.c.project_id == project_id, db.project_shares.c.user_id == other["id"]))
        c.execute(db.project_shares.insert().values(project_id=project_id, user_id=other["id"], can_edit=req.canEdit))
    return {"userId": other["id"], "email": other["email"], "canEdit": req.canEdit}


@router.delete("/api/projects/{project_id}/shares/{user_id}", status_code=204)
def unshare_project(project_id: str, user_id: str, p: Principal = Depends(require_user)) -> Response:
    _, access = _access(p, project_id)
    if access != "owner" and user_id != p.user_id:  # owners remove anyone; others can leave a project shared with them
        raise HTTPException(403, "Only the project's owner can change who it is shared with.")
    with db.connect() as c:
        c.execute(delete(db.project_shares).where(db.project_shares.c.project_id == project_id, db.project_shares.c.user_id == user_id))
    return Response(status_code=204)
