"""Celery application and the task that runs every TerraX job.

Workers start with ``celery -A terrax.tasks worker``. Without Redis, the API can
run jobs itself: TERRAX_EAGER=true runs each one inside its request (tests,
development) and TERRAX_JOB_THREADS=n runs them on n background threads
(one-container hosting).
"""

from __future__ import annotations

import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

from celery import Celery
from celery.exceptions import SoftTimeLimitExceeded
from celery.signals import worker_process_init

from . import storage
from .config import settings
from .monitoring import configure_logging, init_sentry, purge_errors, record_exception

log = logging.getLogger("terrax.jobs")

_s = settings()
celery_app = Celery("terrax", broker=_s.redis_url, backend=_s.redis_url)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_acks_late=True,  # a job is re-queued if its worker dies mid-run
    worker_prefetch_multiplier=1,  # long jobs: one at a time per worker process
    task_time_limit=60 * _s.job_minutes,
    task_soft_time_limit=60 * (_s.job_minutes - 1),
    # Heavy rasters can leave a worker process large; it is replaced after the job (Celery counts KiB).
    worker_max_memory_per_child=_s.worker_max_memory_mb * 1024 or None,
    result_expires=3600,
    broker_connection_retry_on_startup=True,
    beat_schedule={"purge-old-files": {"task": "terrax.purge", "schedule": 3600.0}},
)


def run_job(job_id: str) -> dict:
    """Runs one job to completion and records the outcome in its status file."""
    from .tools import load_all
    from .tools.context import ToolContext, ToolError

    req = storage.job_request(job_id)
    tools = load_all()
    runner = tools.get(req["tool"])
    started = time.time()
    storage.update_job(job_id, state="running", progress=0.02, message="Starting", started=started)
    try:
        if runner is None:
            raise ToolError(f"Unknown tool “{req['tool']}”.")
        result = runner(ToolContext(job_id), req.get("inputs") or {}, req.get("params") or {})
        storage.write_json(storage.job_dir(job_id) / "result.json", result)
        name = result.get("name") if isinstance(result, dict) else None
        return storage.update_job(job_id, state="done", progress=1.0, message="Done", seconds=round(time.time() - started, 2), name=str(name or "")[:300])
    except ToolError as err:
        return storage.update_job(job_id, state="error", message=str(err), error=str(err))
    except ValueError as err:  # data problems raised by the processing modules
        return storage.update_job(job_id, state="error", message=str(err), error=str(err))
    except SoftTimeLimitExceeded:
        msg = (f"The analysis took longer than the {settings().job_minutes}-minute limit and was stopped. "
               "Try a smaller area (an analysis boundary) or a coarser export, or raise TERRAX_JOB_MINUTES on the server.")
        return storage.update_job(job_id, state="error", message=msg, error=msg)
    except MemoryError:
        msg = ("The server ran out of memory for this raster. Try a smaller area or a coarser export, "
               "or lower TERRAX_MAX_PIXELS / TERRAX_TILE_THREADS, or run the workers on a machine with more memory.")
        return storage.update_job(job_id, state="error", message=msg, error=msg)
    except Exception as err:  # record any failure so the UI stops waiting
        log.exception("job %s failed", job_id, extra={"job_id": job_id, "tool": req.get("tool")})
        record_exception("worker", err, path=f"job:{req.get('tool')}:{job_id}", owner=str(req.get("owner") or ""))
        msg = f"The analysis failed unexpectedly ({type(err).__name__}: {err})."
        return storage.update_job(job_id, state="error", message=msg, error=msg, trace=traceback.format_exc()[-4000:])


@celery_app.task(name="terrax.run_job")
def run_job_task(job_id: str) -> dict:
    return run_job(job_id)


@celery_app.task(name="terrax.purge")
def purge_task() -> int:
    purge_errors()
    return storage.purge_old()


@worker_process_init.connect
def _worker_start(**_kwargs) -> None:
    configure_logging()
    init_sentry("worker")


@lru_cache(maxsize=1)
def _job_pool(threads: int) -> ThreadPoolExecutor:
    return ThreadPoolExecutor(max_workers=threads, thread_name_prefix="terrax-job")


def submit(job_id: str) -> None:
    """Queues a job on the workers, runs it on a background thread, or runs it right away in eager mode."""
    s = settings()
    if s.eager:
        run_job(job_id)
    elif s.job_threads > 0:
        _job_pool(s.job_threads).submit(run_job, job_id)
    else:
        run_job_task.delay(job_id)


def job_mode() -> str:
    """How jobs run: "inline" (eager), "threads" or "celery"."""
    s = settings()
    return "inline" if s.eager else "threads" if s.job_threads > 0 else "celery"


_purge_started = threading.Event()


def start_purge_thread(every_s: float = 3600.0) -> None:
    """Hourly clean-up when no Celery beat runs (thread mode); started once per process."""
    if _purge_started.is_set():
        return
    _purge_started.set()

    def loop() -> None:
        while True:
            try:
                purge_errors()
                n = storage.purge_old()
                if n:
                    log.info("purged %d old upload/job folders", n)
            except Exception:  # a failed clean-up must not stop later ones
                log.exception("purge failed")
            time.sleep(every_s)

    threading.Thread(target=loop, name="terrax-purge", daemon=True).start()
