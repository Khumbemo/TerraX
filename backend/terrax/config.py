"""Settings read from the environment (see backend/.env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    #: Where uploads, job folders and results live. Shared by the API and the workers.
    storage_dir: Path = field(default_factory=lambda: Path(os.environ.get("TERRAX_STORAGE", BACKEND_DIR / "storage")))
    #: Bundled read-only data: sample files and built-in world maps.
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("TERRAX_DATA", BACKEND_DIR / "data")))
    redis_url: str = field(default_factory=lambda: os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    #: Run jobs inside the API process instead of on Celery workers (tests, single-process dev).
    eager: bool = field(default_factory=lambda: _bool("TERRAX_EAGER", False))
    gemini_api_key: str = field(default_factory=lambda: os.environ.get("GEMINI_API_KEY", ""))
    gemini_model: str = field(default_factory=lambda: os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"))
    #: Comma-separated origins allowed to call the API from a browser.
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o.strip() for o in os.environ.get("TERRAX_CORS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip())
    )
    #: Largest accepted upload, bytes.
    max_upload: int = field(default_factory=lambda: int(os.environ.get("TERRAX_MAX_UPLOAD_MB", "500")) * 1024 * 1024)
    #: Delete uploads and jobs older than this many hours (0 keeps them).
    retention_hours: int = field(default_factory=lambda: int(os.environ.get("TERRAX_RETENTION_HOURS", "72")))


def settings() -> Settings:
    return Settings()
