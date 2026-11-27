"""Site settings that administrators change in the Admin tab, kept in the database (table site_settings).

Each one overrides its environment default while it is set, and goes back to it when cleared:

* ``signup``: "open" or "closed" (default TERRAX_SIGNUP).
* ``announcement``: a message shown to everyone at the top of the app.
* ``maintenance`` and ``maintenanceMessage``: while on, new analyses are refused for everyone but administrators.
* ``contactName``, ``contactEmail``, ``supportEmail``, ``supportUrl``: who runs this server and where to ask, shown in
  Settings → About. They are entered by an administrator; nothing is preset.

Values are read from the database at most every few seconds per process, so a change reaches every worker quickly.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any

from sqlalchemy import delete, select

from . import db
from .config import settings

_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
_URL = re.compile(r"^https?://[^\s<>\"']+$", re.IGNORECASE)

#: key → (kind, maximum length for text)
KEYS: dict[str, tuple[str, int]] = {
    "signup": ("signup", 0),
    "announcement": ("text", 500),
    "maintenance": ("bool", 0),
    "maintenanceMessage": ("text", 300),
    "contactName": ("text", 120),
    "contactEmail": ("email", 254),
    "supportEmail": ("email", 254),
    "supportUrl": ("url", 300),
}

CACHE_SECONDS = 5.0
_cache: tuple[float, dict[str, Any]] | None = None
_lock = threading.Lock()


def clean(key: str, value: Any) -> Any:
    """The value to store, None to clear the setting; ValueError with a message for the admin otherwise."""
    if key not in KEYS:
        raise ValueError(f"Unknown setting “{key}”.")
    kind, limit = KEYS[key]
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if kind == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"“{key}” is on or off.")
        return value
    if not isinstance(value, str):
        raise ValueError(f"“{key}” must be text.")
    v = value.strip()
    if kind == "signup":
        if v not in ("open", "closed"):
            raise ValueError("Sign-up is open or closed.")
        return v
    if len(v) > limit:
        raise ValueError(f"Keep “{key}” under {limit} characters.")
    if kind == "email" and not _EMAIL.match(v):
        raise ValueError(f"“{v}” is not an e-mail address.")
    if kind == "url" and not _URL.match(v):
        raise ValueError("The support link must start with https:// (or http://).")
    return v


def stored() -> dict[str, Any]:
    """The settings administrators have set (cached for a few seconds)."""
    global _cache
    now = time.monotonic()
    with _lock:
        if _cache and now - _cache[0] < CACHE_SECONDS:
            return dict(_cache[1])
    with db.connect() as c:
        rows = {r.key: r.value for r in c.execute(select(db.site_settings)).all() if r.key in KEYS}
    with _lock:
        _cache = (now, rows)
    return dict(rows)


def update(changes: dict[str, Any], by: str) -> dict[str, Any]:
    """Applies changes (None clears a setting) after checking every value; returns the stored settings."""
    global _cache
    cleaned = {k: clean(k, v) for k, v in changes.items()}
    now = time.time()
    with db.connect() as c:
        for k, v in cleaned.items():
            c.execute(delete(db.site_settings).where(db.site_settings.c.key == k))
            if v is not None:
                c.execute(db.site_settings.insert().values(key=k, value=v, updated=now, updated_by=by))
    with _lock:
        _cache = None
    return stored()


def signup() -> str:
    """Whether people may create accounts: the Admin tab's choice, else TERRAX_SIGNUP."""
    return str(stored().get("signup") or settings().signup)


def maintenance() -> str | None:
    """The message to show while new analyses are paused, or None."""
    s = stored()
    if not s.get("maintenance"):
        return None
    return str(s.get("maintenanceMessage") or "TerraX is under maintenance: new analyses are paused for now. Please try again later.")


def public() -> dict[str, Any]:
    """What every visitor may see: the announcement, maintenance and who to contact."""
    from . import __version__

    s = stored()
    return {
        "announcement": s.get("announcement"),
        "maintenance": maintenance(),
        "contact": {k: s.get(k) for k in ("contactName", "contactEmail", "supportEmail", "supportUrl")},
        "version": __version__,
        "licence": "MIT",
    }
