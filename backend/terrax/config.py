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
    #: Run jobs on this many background threads of the API process instead of Celery workers (one-container hosting, no Redis). 0 uses Celery.
    job_threads: int = field(default_factory=lambda: int(os.environ.get("TERRAX_JOB_THREADS", "0")))
    #: Folder with the built web app (frontend/dist) for the API to serve itself, so one container runs everything.
    static_dir: Path | None = field(default_factory=lambda: Path(p) if (p := os.environ.get("TERRAX_STATIC")) else None)
    gemini_api_key: str = field(default_factory=lambda: os.environ.get("GEMINI_API_KEY", ""))
    gemini_model: str = field(default_factory=lambda: os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"))
    #: Comma-separated origins allowed to call the API from a browser.
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o.strip() for o in os.environ.get("TERRAX_CORS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip())
    )
    #: Full-resolution pixel budget for tools that work in strips (forest, indices, series, land cover);
    #: larger rasters are resampled to it. Memory is about 10 bytes per pixel plus the strips in flight.
    max_pixels: int = field(default_factory=lambda: int(float(os.environ.get("TERRAX_MAX_PIXELS", "1e8"))))
    #: Pixel budget for DEMs (terrain, hydrology, watersheds): slope works in strips, flow routing needs the whole grid
    #: (about 40 bytes a pixel), so this budget sits between the two others.
    dem_pixels: int = field(default_factory=lambda: int(float(os.environ.get("TERRAX_DEM_PIXELS", "2.5e7"))))
    #: Pixel budget for tools that need the whole grid in memory at once (previews, canopy rasters).
    grid_pixels: int = field(default_factory=lambda: int(float(os.environ.get("TERRAX_GRID_PIXELS", "4e6"))))
    #: Result grids with a longer side than this also get full-resolution map tiles (the map picture is thinned to 4096).
    tiles_min_side: int = field(default_factory=lambda: max(1, int(os.environ.get("TERRAX_TILES_MIN_SIDE", "4096"))))
    #: Threads that process strips of one raster in parallel (GDAL reads and NumPy release the GIL).
    tile_threads: int = field(default_factory=lambda: max(1, int(os.environ.get("TERRAX_TILE_THREADS", "0")) or min(4, os.cpu_count() or 1)))
    #: Hard time limit for one job, minutes (the job is told to stop a minute earlier).
    job_minutes: int = field(default_factory=lambda: max(2, int(os.environ.get("TERRAX_JOB_MINUTES", "60"))))
    #: Restart a Celery worker process after a job leaves it above this much memory, MB (0 = never).
    worker_max_memory_mb: int = field(default_factory=lambda: int(os.environ.get("TERRAX_WORKER_MAX_MEMORY_MB", "0")))
    #: Largest accepted upload, bytes.
    max_upload: int = field(default_factory=lambda: int(os.environ.get("TERRAX_MAX_UPLOAD_MB", "500")) * 1024 * 1024)
    #: Delete guests' uploads and jobs older than this many hours (0 keeps them).
    retention_hours: int = field(default_factory=lambda: int(os.environ.get("TERRAX_RETENTION_HOURS", "72")))
    #: Keep signed-in users' uploads and results this many days (0 keeps them until deleted). Job history outlives them.
    user_retention_days: int = field(default_factory=lambda: int(os.environ.get("TERRAX_USER_RETENTION_DAYS", "30")))

    # ── Accounts, access and limits ──
    #: SQLAlchemy URL of the database; empty uses SQLite in the storage folder (storage/terrax.db).
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", ""))
    #: "off" (no accounts: each browser only sees its own uploads and jobs), "optional" (guests as with "off", or sign in
    #: to keep history and projects) or "required" (sign in for everything; use this on a public server).
    auth_mode: str = field(default_factory=lambda: os.environ.get("TERRAX_AUTH", "optional").strip().lower())
    #: Who may create an account: "open" (anyone) or "closed" (only an admin, from the admin panel or the CLI).
    signup: str = field(default_factory=lambda: os.environ.get("TERRAX_SIGNUP", "open").strip().lower())
    #: An admin account created (or reset to this password) at start-up, so a fresh server can be signed in to.
    admin_email: str = field(default_factory=lambda: os.environ.get("TERRAX_ADMIN_EMAIL", "").strip().lower())
    admin_password: str = field(default_factory=lambda: os.environ.get("TERRAX_ADMIN_PASSWORD", ""))
    #: How long a sign-in lasts without use, days.
    session_days: int = field(default_factory=lambda: max(1, int(os.environ.get("TERRAX_SESSION_DAYS", "30"))))
    #: Session cookies only over HTTPS: "auto" (when the request arrived over HTTPS, also behind a proxy), "true", "false".
    cookie_secure: str = field(default_factory=lambda: os.environ.get("TERRAX_COOKIE_SECURE", "auto").strip().lower())
    #: SameSite for the session and guest cookies: "lax", or "none" when the app is shown inside another site's frame;
    #: "none" also makes them Secure and Partitioned (CHIPS), so it needs HTTPS. Default: "none" on Hugging Face Spaces
    #: (which set SPACE_ID and show the app in a frame on huggingface.co), else "lax".
    cookie_samesite: str = field(default_factory=lambda: os.environ.get("TERRAX_COOKIE_SAMESITE", "none" if os.environ.get("SPACE_ID") else "lax").strip().lower())
    #: Proxies in front of the API whose X-Forwarded-For / X-Forwarded-Proto to trust (0: use the socket address).
    trusted_proxies: int = field(default_factory=lambda: max(0, int(os.environ.get("TERRAX_TRUSTED_PROXIES", "0"))))
    #: Request limits per user or guest (and per client address); false switches them off (tests, a private server).
    rate_limits: bool = field(default_factory=lambda: _bool("TERRAX_RATE_LIMITS", True))
    jobs_per_minute: int = field(default_factory=lambda: max(1, int(os.environ.get("TERRAX_JOBS_PER_MINUTE", "30"))))
    uploads_per_hour: int = field(default_factory=lambda: max(1, int(os.environ.get("TERRAX_UPLOADS_PER_HOUR", "300"))))
    #: Storage each signed-in user / each guest may hold at once, MB (0: no limit).
    user_quota_mb: int = field(default_factory=lambda: max(0, int(os.environ.get("TERRAX_USER_QUOTA_MB", "10000"))))
    guest_quota_mb: int = field(default_factory=lambda: max(0, int(os.environ.get("TERRAX_GUEST_QUOTA_MB", "2000"))))

    # ── Monitoring ──
    #: "text" (readable) or "json" (one JSON object per line, for log collectors).
    log_format: str = field(default_factory=lambda: os.environ.get("TERRAX_LOG_FORMAT", "text").strip().lower())
    log_level: str = field(default_factory=lambda: os.environ.get("TERRAX_LOG_LEVEL", "INFO").strip().upper())
    #: Bearer token for /api/metrics (Prometheus); without it only admins can read the metrics.
    metrics_token: str = field(default_factory=lambda: os.environ.get("TERRAX_METRICS_TOKEN", ""))
    #: Sentry (or a Sentry-compatible service such as GlitchTip) DSN for error tracking; needs ``pip install 'terrax[sentry]'``.
    sentry_dsn: str = field(default_factory=lambda: os.environ.get("SENTRY_DSN", ""))
    sentry_environment: str = field(default_factory=lambda: os.environ.get("SENTRY_ENVIRONMENT", "production"))
    #: Keep recorded errors this many days.
    error_retention_days: int = field(default_factory=lambda: max(1, int(os.environ.get("TERRAX_ERROR_RETENTION_DAYS", "30"))))


def settings() -> Settings:
    return Settings()
