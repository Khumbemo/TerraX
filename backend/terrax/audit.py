"""The audit log: who did what to which account, kept for TERRAX_AUDIT_RETENTION_DAYS.

Security events (sign-ins and failed ones, password and two-factor changes, resets, account deletion, sessions ended)
and every administrator action (accounts created, changed or deleted, errors cleared). Passwords, tokens and codes
are never written; the detail says what changed.
"""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import Request

from .config import settings


def record(action: str, request: Request | None = None, actor: dict[str, Any] | None = None, target: str = "", detail: dict[str, Any] | str = "") -> None:
    """Writes one entry (never raises: a failed audit write is logged, not turned into a failed request)."""
    from . import db
    from .auth import Principal, client_ip

    if actor is None and request is not None:
        p: Principal | None = getattr(request.state, "principal", None)
        actor = p.user if p else None
    try:
        with db.connect() as c:
            c.execute(db.audit.insert().values(
                at=time.time(), actor=(actor or {}).get("id", "") or "", actor_email=(actor or {}).get("email", "") or "", action=action[:60], target=target[:254],
                detail=(detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False, sort_keys=True))[:4000],
                ip=client_ip(request)[:64] if request is not None else ""))
    except Exception:
        import logging

        logging.getLogger("terrax.audit").exception("could not write the audit entry %s", action)


def purge() -> int:
    from sqlalchemy import delete

    from . import db

    cutoff = time.time() - settings().audit_retention_days * 86400
    with db.connect() as c:
        return int(c.execute(delete(db.audit).where(db.audit.c.at < cutoff)).rowcount or 0)
