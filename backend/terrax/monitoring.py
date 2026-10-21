"""Logs, metrics and error tracking.

* Every API request gets an ID (the client's X-Request-ID, or a new one), returned in the response and written on
  every log line, so a user's report can be matched to the server's logs. TERRAX_LOG_FORMAT=json writes one JSON
  object per line for log collectors (Loki, CloudWatch, Datadog, …).
* /api/metrics speaks the Prometheus text format (version 0.0.4): request counts and latency by route, uploads, jobs
  by tool and state with run times (read from the database, so jobs on any worker count), recorded errors, and
  process memory.
* Unexpected errors in the API, in jobs (workers) and in browsers (POST /api/client-errors) are recorded in the
  database for the admin panel, and sent to Sentry (or a Sentry-compatible service) when SENTRY_DSN is set.
"""

from __future__ import annotations

import contextvars
import json
import logging
import sys
import threading
import time
import traceback
import uuid
from typing import Any

from .config import settings

request_id: contextvars.ContextVar[str] = contextvars.ContextVar("terrax_request_id", default="")
log = logging.getLogger("terrax")


# ── Logging ──────────────────────────────────────────────────────────────────


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id.get()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {"time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
                               "level": record.levelname, "logger": record.name, "message": record.getMessage()}
        rid = getattr(record, "request_id", "")
        if rid:
            out["request_id"] = rid
        for key in ("method", "path", "status", "ms", "owner", "job_id", "tool"):
            if hasattr(record, key):
                out[key] = getattr(record, key)
        if record.exc_info:
            out["exception"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=False)


_configured = False


def configure_logging() -> None:
    """Sets up the terrax loggers once per process (format and level from the settings)."""
    global _configured
    if _configured:
        return
    _configured = True
    s = settings()
    handler = logging.StreamHandler(sys.stderr)
    handler.addFilter(_RequestIdFilter())
    if s.log_format == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"))
    root = logging.getLogger("terrax")
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, s.log_level, logging.INFO))
    root.propagate = False


def new_request_id(incoming: str | None) -> str:
    rid = (incoming or "").strip()
    return rid[:64] if rid and all(ch.isalnum() or ch in "-_." for ch in rid) else uuid.uuid4().hex


# ── Metrics ──────────────────────────────────────────────────────────────────

#: Request latency buckets, seconds (Prometheus histogram upper bounds).
BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0)


class Metrics:
    """In-process counters and histograms of this API process (jobs are counted from the database instead)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests: dict[tuple[str, str, str], int] = {}
        self.latency: dict[tuple[str, str], list[float]] = {}  # per bucket counts, then +Inf count and sum
        self.counters: dict[str, int] = {}
        self.started = time.time()

    def request(self, method: str, route: str, status: int, seconds: float) -> None:
        key = (method, route, f"{status // 100}xx")
        with self._lock:
            self.requests[key] = self.requests.get(key, 0) + 1
            h = self.latency.setdefault((method, route), [0.0] * (len(BUCKETS) + 2))
            for i, b in enumerate(BUCKETS):
                if seconds <= b:
                    h[i] += 1
            h[len(BUCKETS)] += 1
            h[len(BUCKETS) + 1] += seconds

    def count(self, name: str, n: int = 1) -> None:
        with self._lock:
            self.counters[name] = self.counters.get(name, 0) + n

    def reset(self) -> None:
        with self._lock:
            self.requests.clear()
            self.latency.clear()
            self.counters.clear()


metrics = Metrics()


def _label(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def render_metrics() -> str:
    """All metrics in the Prometheus text exposition format."""
    from sqlalchemy import func, select

    from . import db

    lines: list[str] = []

    def family(name: str, kind: str, help_: str) -> None:
        lines.append(f"# HELP {name} {help_}")
        lines.append(f"# TYPE {name} {kind}")

    with metrics._lock:
        requests = dict(metrics.requests)
        latency = {k: list(v) for k, v in metrics.latency.items()}
        counters = dict(metrics.counters)
    family("terrax_http_requests_total", "counter", "HTTP requests handled by this API process, by route and status class.")
    for (m, route, cls), n in sorted(requests.items()):
        lines.append(f'terrax_http_requests_total{{method="{m}",route="{_label(route)}",status="{cls}"}} {n}')
    family("terrax_http_request_duration_seconds", "histogram", "Time to answer an HTTP request.")
    for (m, route), h in sorted(latency.items()):
        lab = f'method="{m}",route="{_label(route)}"'
        for i, b in enumerate(BUCKETS):
            lines.append(f'terrax_http_request_duration_seconds_bucket{{{lab},le="{b}"}} {int(h[i])}')
        lines.append(f'terrax_http_request_duration_seconds_bucket{{{lab},le="+Inf"}} {int(h[len(BUCKETS)])}')
        lines.append(f"terrax_http_request_duration_seconds_count{{{lab}}} {int(h[len(BUCKETS)])}")
        lines.append(f"terrax_http_request_duration_seconds_sum{{{lab}}} {h[len(BUCKETS) + 1]:.6f}")
    for name, help_ in (("uploads", "Files uploaded."), ("upload_bytes", "Bytes uploaded."), ("rate_limited", "Requests refused by a rate limit."),
                        ("logins", "Successful sign-ins."), ("login_failures", "Failed sign-ins."), ("signups", "Accounts created.")):
        family(f"terrax_{name}_total", "counter", help_)
        lines.append(f"terrax_{name}_total {counters.get(name, 0)}")

    with db.connect() as c:
        by_state = c.execute(select(db.jobs.c.tool, db.jobs.c.state, func.count()).group_by(db.jobs.c.tool, db.jobs.c.state)).all()
        cutoff = time.time() - 3600
        recent = c.execute(select(db.jobs.c.tool, func.count(), func.sum(db.jobs.c.seconds), func.max(db.jobs.c.seconds))
                           .where(db.jobs.c.state == "done", db.jobs.c.updated >= cutoff).group_by(db.jobs.c.tool)).all()
        queued = int(c.execute(select(func.count()).select_from(db.jobs).where(db.jobs.c.state.in_(("queued", "running")))).scalar_one())
        errs = c.execute(select(db.errors.c.source, func.count()).group_by(db.errors.c.source)).all()
        n_users = int(c.execute(select(func.count()).select_from(db.users)).scalar_one())
        stored = int(c.execute(select(func.coalesce(func.sum(db.files.c.size), 0)).where(db.files.c.purged.is_(False))).scalar_one())
    family("terrax_jobs", "gauge", "Jobs in the database by tool and state (all workers).")
    for tool, state, n in sorted(by_state):
        lines.append(f'terrax_jobs{{tool="{_label(tool)}",state="{state}"}} {n}')
    family("terrax_jobs_in_flight", "gauge", "Jobs queued or running.")
    lines.append(f"terrax_jobs_in_flight {queued}")
    family("terrax_job_seconds_last_hour", "gauge", "Run time of jobs finished in the last hour, by tool: count, sum and max.")
    for tool, n, total, worst in sorted(recent):
        lab = f'tool="{_label(tool)}"'
        lines.append(f'terrax_job_seconds_last_hour{{{lab},stat="count"}} {n}')
        lines.append(f'terrax_job_seconds_last_hour{{{lab},stat="sum"}} {float(total or 0):.3f}')
        lines.append(f'terrax_job_seconds_last_hour{{{lab},stat="max"}} {float(worst or 0):.3f}')
    family("terrax_errors_recorded", "gauge", "Errors kept in the database, by source.")
    for source, n in sorted(errs):
        lines.append(f'terrax_errors_recorded{{source="{source}"}} {n}')
    family("terrax_users", "gauge", "Accounts.")
    lines.append(f"terrax_users {n_users}")
    family("terrax_stored_bytes", "gauge", "Bytes of uploads currently stored.")
    lines.append(f"terrax_stored_bytes {stored}")
    family("terrax_process_resident_bytes", "gauge", "Resident memory of this API process.")
    lines.append(f"terrax_process_resident_bytes {_rss_bytes()}")
    family("terrax_process_uptime_seconds", "gauge", "Seconds since this API process started.")
    lines.append(f"terrax_process_uptime_seconds {time.time() - metrics.started:.0f}")
    return "\n".join(lines) + "\n"


def _rss_bytes() -> int:
    try:
        with open("/proc/self/statm", encoding="ascii") as fh:
            import os

            return int(fh.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        import resource

        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


# ── Errors ───────────────────────────────────────────────────────────────────

_sentry_ready = False


def init_sentry(component: str) -> bool:
    """Starts Sentry when SENTRY_DSN is set and sentry-sdk is installed; returns whether it is on."""
    global _sentry_ready
    s = settings()
    if not s.sentry_dsn or _sentry_ready:
        return _sentry_ready
    try:
        import sentry_sdk
    except ImportError:
        log.warning("SENTRY_DSN is set but sentry-sdk is not installed (pip install 'terrax[sentry]'); errors are only recorded in the database.")
        return False
    from . import __version__

    sentry_sdk.init(dsn=s.sentry_dsn, environment=s.sentry_environment, release=f"terrax@{__version__}", send_default_pii=False, traces_sample_rate=0.0,
                    server_name=component)
    _sentry_ready = True
    return True


def _to_sentry(exc: BaseException | None, message: str, extra: dict[str, Any]) -> None:
    if not _sentry_ready:
        return
    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            for k, v in extra.items():
                scope.set_tag(k, str(v)[:200])
            if exc is not None:
                sentry_sdk.capture_exception(exc)
            else:
                sentry_sdk.capture_message(message, level="error")
    except Exception:  # error reporting must never raise
        log.debug("sentry capture failed", exc_info=True)


def record_error(source: str, kind: str, message: str, detail: str = "", path: str = "", owner: str = "", exc: BaseException | None = None) -> None:
    """Keeps an error for the admin panel (and Sentry). Never raises: monitoring must not break the request."""
    rid = request_id.get()
    try:
        from . import db

        with db.connect() as c:
            c.execute(db.errors.insert().values(at=time.time(), source=source, kind=kind[:120], message=message[:4000], detail=detail[-8000:], path=path[:300],
                                                request_id=rid[:40], owner=owner[:70]))
    except Exception:
        log.exception("could not record an error in the database")
    _to_sentry(exc, message, {"source": source, "path": path, "request_id": rid})


def record_exception(source: str, exc: BaseException, path: str = "", owner: str = "") -> None:
    record_error(source, type(exc).__name__, str(exc) or type(exc).__name__, "".join(traceback.format_exception(exc))[-8000:], path, owner, exc)


def purge_errors() -> int:
    from sqlalchemy import delete

    from . import db

    cutoff = time.time() - settings().error_retention_days * 86400
    with db.connect() as c:
        return int(c.execute(delete(db.errors).where(db.errors.c.at < cutoff)).rowcount or 0)
