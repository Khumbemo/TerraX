"""Administration: accounts, recorded errors, the audit log and usage (admins only). Every change is audited."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update

from .. import audit, auth, db
from ..auth import Principal, require_admin
from .accounts import purge_owner_data

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/users")
def users(q: str = "", limit: int = Query(200, ge=1, le=1000)) -> dict[str, Any]:
    with db.connect() as c:
        stmt = select(db.users)
        if q:
            stmt = stmt.where(db.users.c.email.contains(q.strip().lower()))
        rows = c.execute(stmt.order_by(db.users.c.created.desc()).limit(limit)).all()
        used: dict[str, Any] = dict(c.execute(select(db.files.c.owner, func.sum(db.files.c.size)).where(db.files.c.purged.is_(False)).group_by(db.files.c.owner)).all())
        n_jobs: dict[str, Any] = dict(c.execute(select(db.jobs.c.owner, func.count()).group_by(db.jobs.c.owner)).all())
    return {"users": [auth.public_user(dict(r._mapping)) | {"usedBytes": int(used.get(f"u:{r.id}", 0) or 0), "jobs": int(n_jobs.get(f"u:{r.id}", 0))} for r in rows]}


class NewUser(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., max_length=auth.MAX_PASSWORD)
    name: str = Field("", max_length=120)
    role: str = "user"


@router.post("/users", status_code=201)
def add_user(req: NewUser, request: Request) -> dict[str, Any]:
    u = auth.create_user(req.email, req.password, req.name, req.role, verified=True)  # the admin vouches for the address
    audit.record("admin.user_created", request, target=u["email"], detail={"role": u["role"]})
    return auth.public_user(u)


class UserPatch(BaseModel):
    role: str | None = None
    disabled: bool | None = None
    password: str | None = Field(None, max_length=auth.MAX_PASSWORD)
    name: str | None = Field(None, max_length=120)
    #: False turns two-factor sign-in off (someone who lost their phone and their recovery codes).
    twoFactor: bool | None = None
    #: True marks the e-mail address as confirmed.
    emailVerified: bool | None = None


@router.patch("/users/{user_id}")
def change_user(user_id: str, req: UserPatch, request: Request, p: Principal = Depends(require_admin)) -> dict[str, Any]:
    u = auth.get_user(user_id)
    if u is None:
        raise KeyError(user_id)
    demoting = (req.role is not None and req.role != "admin") or req.disabled is True
    if demoting and u["role"] == "admin" and not u["disabled"] and auth.count_admins() <= 1:
        raise HTTPException(400, "This is the only administrator; make another account an administrator first.")
    values: dict[str, Any] = {}
    if req.role is not None:
        if req.role not in ("user", "admin"):
            raise HTTPException(400, "A role is user or admin.")
        values["role"] = req.role
    if req.disabled is not None:
        values["disabled"] = req.disabled
    if req.name is not None:
        values["name"] = req.name.strip()
    if req.twoFactor is True:
        raise HTTPException(400, "Only the account's owner can turn two-factor sign-in on (it needs their phone).")
    if req.twoFactor is False:
        values |= {"totp_enabled": False, "totp_secret": None, "totp_last_step": None}
    if req.emailVerified is not None:
        values["email_verified"] = req.emailVerified
    if values:
        with db.connect() as c:
            c.execute(update(db.users).where(db.users.c.id == user_id).values(**values))
            if req.disabled:
                c.execute(delete(db.sessions).where(db.sessions.c.user_id == user_id))
            if req.twoFactor is False:
                c.execute(delete(db.recovery_codes).where(db.recovery_codes.c.user_id == user_id))
    if req.password:
        auth.set_password(user_id, req.password)
    changed = {k: v for k, v in {"role": req.role, "disabled": req.disabled, "name": req.name, "twoFactor": req.twoFactor, "emailVerified": req.emailVerified}.items() if v is not None}
    if req.password:
        changed["password"] = "set"
    audit.record("admin.user_changed", request, target=u["email"], detail=changed)
    return auth.public_user(auth.get_user(user_id) or u)


@router.delete("/users/{user_id}", status_code=204)
def remove_user(user_id: str, request: Request, p: Principal = Depends(require_admin)) -> Response:
    u = auth.get_user(user_id)
    if u is None:
        raise KeyError(user_id)
    if u["role"] == "admin" and auth.count_admins() <= 1:
        raise HTTPException(400, "This is the only administrator; make another account an administrator first.")
    purge_owner_data(f"u:{user_id}")
    with db.connect() as c:
        c.execute(delete(db.users).where(db.users.c.id == user_id))
    audit.record("admin.user_deleted", request, target=u["email"])
    return Response(status_code=204)


@router.get("/errors")
def errors(source: str | None = None, limit: int = Query(100, ge=1, le=1000), before: float | None = None) -> dict[str, Any]:
    stmt = select(db.errors)
    if source:
        stmt = stmt.where(db.errors.c.source == source)
    if before is not None:
        stmt = stmt.where(db.errors.c.at < before)
    with db.connect() as c:
        rows = c.execute(stmt.order_by(db.errors.c.at.desc()).limit(limit)).all()
    return {"errors": [{"id": r.id, "at": r.at, "source": r.source, "kind": r.kind, "message": r.message, "detail": r.detail, "path": r.path,
                        "requestId": r.request_id, "owner": r.owner} for r in rows]}


@router.delete("/errors", status_code=204)
def clear_errors(request: Request) -> Response:
    with db.connect() as c:
        n = c.execute(delete(db.errors)).rowcount
    audit.record("admin.errors_cleared", request, detail={"count": n})
    return Response(status_code=204)


@router.get("/audit")
def audit_log(action: str | None = None, q: str = "", limit: int = Query(200, ge=1, le=1000), before: float | None = None) -> dict[str, Any]:
    """Audit entries, newest first; `action` filters by prefix (auth., admin., or a full name), `q` by e-mail."""
    stmt = select(db.audit)
    if action:
        stmt = stmt.where(db.audit.c.action.startswith(action))
    if q:
        needle = q.strip().lower()
        stmt = stmt.where((db.audit.c.target.contains(needle, autoescape=True)) | (db.audit.c.actor_email.contains(needle, autoescape=True)))
    if before is not None:
        stmt = stmt.where(db.audit.c.at < before)
    with db.connect() as c:
        rows = c.execute(stmt.order_by(db.audit.c.at.desc(), db.audit.c.id.desc()).limit(limit)).all()
    return {"entries": [{"id": r.id, "at": r.at, "actor": r.actor_email, "action": r.action, "target": r.target, "detail": r.detail, "ip": r.ip} for r in rows]}


@router.get("/stats")
def stats() -> dict[str, Any]:
    day = time.time() - 86400
    with db.connect() as c:
        jobs_day: dict[str, Any] = dict(c.execute(select(db.jobs.c.state, func.count()).where(db.jobs.c.created >= day).group_by(db.jobs.c.state)).all())
        tools_day: dict[str, Any] = dict(c.execute(select(db.jobs.c.tool, func.count()).where(db.jobs.c.created >= day).group_by(db.jobs.c.tool)).all())
        return {
            "users": int(c.execute(select(func.count()).select_from(db.users)).scalar_one()),
            "activeSessions": int(c.execute(select(func.count()).select_from(db.sessions).where(db.sessions.c.expires > time.time())).scalar_one()),
            "storedBytes": int(c.execute(select(func.coalesce(func.sum(db.files.c.size), 0)).where(db.files.c.purged.is_(False))).scalar_one()),
            "files": int(c.execute(select(func.count()).select_from(db.files).where(db.files.c.purged.is_(False))).scalar_one()),
            "jobsLastDay": {k: int(v) for k, v in jobs_day.items()},
            "toolsLastDay": {k: int(v) for k, v in tools_day.items()},
            "errorsLastDay": int(c.execute(select(func.count()).select_from(db.errors).where(db.errors.c.at >= day)).scalar_one()),
            "projects": int(c.execute(select(func.count()).select_from(db.projects)).scalar_one()),
        }


# Site settings, system status, all jobs, backups and clean-up ------------------------------------------------------


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    """The site settings administrators have set, and the server defaults they override."""
    from .. import site
    from ..config import settings

    return {"settings": site.stored(), "defaults": {"signup": settings().signup}}


@router.put("/settings")
def put_settings(changes: dict[str, Any], request: Request, p: Principal = Depends(require_admin)) -> dict[str, Any]:
    """Changes some settings; a null or empty value clears one (back to the server default). Audited."""
    from .. import site

    try:
        out = site.update(changes, p.user["email"] if p.user else "")
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    audit.record("admin.settings_changed", request, detail={k: ("set" if v not in (None, "") else "cleared") for k, v in changes.items()})
    return {"settings": out}


@router.get("/system")
def system() -> dict[str, Any]:
    """Health checks and the server's configuration as it is running (never secrets: only whether they are set)."""
    import platform

    from .. import __version__, mailer, oidc, site
    from ..agents.llm import server_configured
    from ..config import settings
    from ..tasks import job_mode
    from .main import STARTED, readiness_checks

    s = settings()
    checks = readiness_checks()
    return {
        "version": __version__, "python": platform.python_version(), "uptimeSeconds": time.time() - STARTED,
        "checks": checks, "ok": all(checks.values()),
        "config": [
            {"name": "Accounts", "value": {"off": "off (guests only)", "optional": "optional (guests and accounts)", "required": "required (everyone signs in)"}.get(s.auth_mode, s.auth_mode), "env": "TERRAX_AUTH"},
            {"name": "Sign-up", "value": site.signup(), "env": "TERRAX_SIGNUP, or the Site settings section"},
            {"name": "Analyses run on", "value": {"celery": "Celery workers", "threads": f"background threads ({s.job_threads})", "inline": "the request itself"}.get(job_mode(), job_mode()), "env": "REDIS_URL / TERRAX_JOB_THREADS"},
            {"name": "Database type", "value": "PostgreSQL" if s.database_url.startswith("postgresql") else "SQLite in the storage folder", "env": "DATABASE_URL"},
            {"name": "Uploads and results", "value": f"bucket {s.s3_bucket}" if s.s3_bucket else "the storage folder on this machine", "env": "TERRAX_S3_BUCKET"},
            {"name": "Guests' work kept", "value": f"{s.retention_hours:g} hours", "env": "TERRAX_RETENTION_HOURS"},
            {"name": "Accounts' work kept", "value": f"{s.user_retention_days:g} days", "env": "TERRAX_USER_RETENTION_DAYS"},
            {"name": "Storage per account / guest", "value": f"{s.user_quota_mb:,} MB / {s.guest_quota_mb:,} MB", "env": "TERRAX_USER_QUOTA_MB / TERRAX_GUEST_QUOTA_MB"},
            {"name": "Largest upload", "value": f"{s.max_upload // (1024 * 1024):,} MB", "env": "TERRAX_MAX_UPLOAD_MB"},
            {"name": "Analyses per minute (each user)", "value": f"{s.jobs_per_minute}" if s.rate_limits else "no limit", "env": "TERRAX_JOBS_PER_MINUTE"},
            {"name": "Database backups", "value": f"every {s.backup_hours:g} hours, newest {s.backup_keep} kept" if s.backup_hours > 0 else "off", "env": "TERRAX_BACKUP_HOURS / TERRAX_BACKUP_KEEP"},
            {"name": "E-mail (password reset)", "value": "set up" if mailer.can_send() else "not set up", "env": "TERRAX_SMTP_*"},
            {"name": "Single sign-on", "value": s.oidc_name if oidc.enabled() else "off", "env": "TERRAX_OIDC_*"},
            {"name": "Server AI key", "value": "set" if server_configured() else "none (users add their own)", "env": "TERRAX_AI_KEY"},
            {"name": "Error reporting to Sentry", "value": "on" if s.sentry_dsn else "off", "env": "SENTRY_DSN"},
        ],
    }


@router.get("/jobs")
def all_jobs(state: str | None = None, tool: str | None = None, limit: int = Query(100, ge=1, le=500)) -> dict[str, Any]:
    """Recent analyses by everyone, newest first, with who ran them (guests are shown as guests)."""
    stmt = select(db.jobs.c.id, db.jobs.c.owner, db.jobs.c.tool, db.jobs.c.state, db.jobs.c.message, db.jobs.c.name, db.jobs.c.created, db.jobs.c.seconds)
    if state:
        stmt = stmt.where(db.jobs.c.state == state)
    if tool:
        stmt = stmt.where(db.jobs.c.tool == tool)
    with db.connect() as c:
        rows = c.execute(stmt.order_by(db.jobs.c.created.desc()).limit(limit)).all()
        ids = {r.owner[2:] for r in rows if r.owner.startswith("u:")}
        emails = dict(c.execute(select(db.users.c.id, db.users.c.email).where(db.users.c.id.in_(ids))).all()) if ids else {}
    return {"jobs": [{"id": r.id, "tool": r.tool, "state": r.state, "name": r.name, "created": r.created, "seconds": r.seconds,
                      "message": r.message if r.state == "error" else "",
                      "who": emails.get(r.owner[2:], "deleted account") if r.owner.startswith("u:") else "guest"} for r in rows]}


@router.get("/backups")
def backups() -> dict[str, Any]:
    from .. import backup
    from ..config import settings

    s = settings()
    return {"backups": backup.list_backups(), "everyHours": s.backup_hours, "keep": s.backup_keep}


@router.post("/backups", status_code=201)
def backup_now(request: Request) -> dict[str, Any]:
    """Backs the database up now (accounts, history, projects, settings), like `python -m terrax.manage backup`."""
    from .. import backup

    made = backup.create()
    audit.record("admin.backup_made", request, detail={"name": made["name"], "rows": sum(made["rows"].values())})
    return {"name": made["name"], "size": made["size"], "rows": sum(made["rows"].values()), "removed": len(made["removed"])}


@router.post("/cleanup")
def cleanup_now(request: Request) -> dict[str, Any]:
    """Runs the hourly clean-up now: expired uploads and results, old errors, rate-limit counters and audit entries."""
    from ..audit import purge as purge_audit
    from ..monitoring import purge_errors
    from ..ratelimit import purge_counters
    from ..storage import purge_old

    out = {"errors": purge_errors(), "counters": purge_counters(), "audit": purge_audit(), "files": purge_old()}
    audit.record("admin.cleanup", request, detail=out)
    return out
