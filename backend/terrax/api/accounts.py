"""Accounts (sign-up, sign-in, sign-out, password, deleting the account) and projects kept on the server.

A project is the document the web app exports as ``.terrax.json`` (boundary, reports, settings); signed-in users can
keep them on the server, open them on any device, and share them with other accounts to read or to edit.
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select, update

from .. import auth, db, ratelimit, storage
from ..auth import Principal, require_user
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
    return {"mode": s.auth_mode, "signup": s.signup, "user": auth.public_user(p.user) if p and p.user else None, "guest": bool(p and p.is_guest)}


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


def _signed_in(request: Request, response: Response, user: dict[str, Any]) -> dict[str, Any]:
    token = auth.start_session(user["id"], auth.client_ip(request), request.headers.get("user-agent", ""))
    _set_session_cookie(response, request, token)
    guest = request.cookies.get(auth.GUEST_COOKIE) or ""
    claimed = auth.claim_guest_data(guest, user["id"]) if len(guest) >= 32 else 0
    request.state.principal = Principal(owner=f"u:{user['id']}", user=user)
    return _me(request) | {"claimed": claimed}


@router.post("/api/auth/signup", status_code=201)
def signup(req: SignUp, request: Request, response: Response) -> dict[str, Any]:
    p: Principal | None = getattr(request.state, "principal", None)
    if settings().signup != "open" and not (p and p.is_admin):
        raise HTTPException(403, "New accounts are created by an administrator on this server.")
    ratelimit.check("signup", auth.client_ip(request))
    user = auth.create_user(req.email, req.password, req.name)
    metrics.count("signups")
    return _signed_in(request, response, user)


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
        raise HTTPException(401, "The e-mail or password is not right.")
    assert user is not None
    metrics.count("logins")
    return _signed_in(request, response, user)


@router.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict[str, Any]:
    token = request.cookies.get(auth.SESSION_COOKIE)
    if token:
        auth.end_session(token)
    auth.clear_cookie(response, request, auth.SESSION_COOKIE)
    return {"ok": True}


class PasswordChange(BaseModel):
    current: str = Field(..., max_length=auth.MAX_PASSWORD)
    new: str = Field(..., max_length=auth.MAX_PASSWORD)


@router.post("/api/auth/password")
def change_password(req: PasswordChange, request: Request, response: Response, p: Principal = Depends(require_user)) -> dict[str, Any]:
    assert p.user is not None
    ratelimit.check("login", auth.client_ip(request), f"email:{p.user['email']}")
    if not auth.verify_password(req.current, p.user["password_hash"]):
        raise HTTPException(401, "The current password is not right.")
    auth.set_password(p.user["id"], req.new)  # ends every session, this one included
    return _signed_in(request, response, auth.get_user(p.user["id"]) or p.user)


class DeleteAccount(BaseModel):
    password: str = Field(..., max_length=auth.MAX_PASSWORD)


@router.post("/api/auth/delete-account")
def delete_account(req: DeleteAccount, request: Request, response: Response, p: Principal = Depends(require_user)) -> dict[str, Any]:
    """Deletes the account, its sessions, projects, uploads, results and history."""
    assert p.user is not None
    if not auth.verify_password(req.password, p.user["password_hash"]):
        raise HTTPException(401, "The password is not right.")
    if p.is_admin and auth.count_admins() <= 1:
        raise HTTPException(400, "This is the only administrator; make another account an administrator first.")
    purge_owner_data(p.owner)
    with db.connect() as c:
        c.execute(delete(db.users).where(db.users.c.id == p.user["id"]))
    auth.clear_cookie(response, request, auth.SESSION_COOKIE)
    return {"ok": True}


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
    pr = {"id": secrets.token_hex(16), "owner": p.user_id, "name": req.name.strip(), "data": req.data, "created": now, "updated": now}
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
        values["data"] = req.data
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
