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
    #: Pixel budget for tools that need the whole grid in memory at once (contours, previews).
    grid_pixels: int = field(default_factory=lambda: int(float(os.environ.get("TERRAX_GRID_PIXELS", "4e6"))))
    #: Threads that process strips of one raster in parallel (GDAL reads and NumPy release the GIL).
    tile_threads: int = field(default_factory=lambda: max(1, int(os.environ.get("TERRAX_TILE_THREADS", "0")) or min(4, os.cpu_count() or 1)))
    #: Hard time limit for one job, minutes (the job is told to stop a minute earlier).
    job_minutes: int = field(default_factory=lambda: max(2, int(os.environ.get("TERRAX_JOB_MINUTES", "60"))))
    #: Restart a Celery worker process after a job leaves it above this much memory, MB (0 = never).
    worker_max_memory_mb: int = field(default_factory=lambda: int(os.environ.get("TERRAX_WORKER_MAX_MEMORY_MB", "0")))
    #: Largest accepted upload, bytes.
    max_upload: int = field(default_factory=lambda: int(os.environ.get("TERRAX_MAX_UPLOAD_MB", "500")) * 1024 * 1024)
    #: Delete uploads and jobs older than this many hours (0 keeps them).
    retention_hours: int = field(default_factory=lambda: int(os.environ.get("TERRAX_RETENTION_HOURS", "72")))


def settings() -> Settings:
    return Settings()
