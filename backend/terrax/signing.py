"""Signed, expiring links to a job's pictures and tiles (and a file's composites), so they load where cookies do not
travel: an <img> or map tile from an API on another site, a figure fetched for a PDF.

A token is ``<expiry>.<HMAC-SHA256(secret, kind:id:expiry), base64url, 128 bits>``. Only the owner receives one (the
job's result is owner-only), and it stops working after TERRAX_MEDIA_URL_HOURS, like a pre-signed cloud-storage link.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import threading
import time
from typing import Any

from .config import settings

_lock = threading.Lock()
_cached: dict[str, bytes] = {}


def secret() -> bytes:
    """TERRAX_SECRET_KEY, or a random key created once in the storage folder (shared by processes using it)."""
    s = settings()
    if s.secret_key:
        return s.secret_key.encode("utf-8")
    path = s.storage_dir / "secret.key"
    key = str(path)
    if key in _cached:
        return _cached[key]
    with _lock:
        if key not in _cached:
            s.storage_dir.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                tmp = path.with_suffix(f".{secrets.token_hex(4)}.tmp")
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as fh:
                    fh.write(secrets.token_hex(32))
                try:
                    os.link(tmp, path)  # atomic: the first process to create it wins, the others read its key
                except FileExistsError:
                    pass
                finally:
                    tmp.unlink(missing_ok=True)
            _cached[key] = path.read_text().strip().encode("utf-8")
    return _cached[key]


def _mac(kind: str, ident: str, exp: int) -> str:
    d = hmac.new(secret(), f"{kind}:{ident}:{exp}".encode(), hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(d).decode().rstrip("=")


def sign(kind: str, ident: str, hours: int | None = None) -> str:
    exp = int(time.time() + 3600 * (hours or settings().media_url_hours))
    return f"{exp}.{_mac(kind, ident, exp)}"


def check(kind: str, ident: str, token: str | None) -> bool:
    if not token or "." not in token:
        return False
    exp_s, mac = token.split(".", 1)
    try:
        exp = int(exp_s)
    except ValueError:
        return False
    return exp >= time.time() and hmac.compare_digest(mac, _mac(kind, ident, exp))


def sign_urls(obj: Any, job_id: str) -> Any:
    """A copy of a job's result with every link to its own artifacts and tiles signed."""
    prefix = f"/api/jobs/{job_id}/"
    token = sign("job", job_id)

    def walk(v: Any) -> Any:
        if isinstance(v, str) and v.startswith(prefix) and "t=" not in v:
            return f"{v}{'&' if '?' in v else '?'}t={token}"
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v

    return walk(obj)
