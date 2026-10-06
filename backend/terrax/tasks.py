"""Celery application and the task that runs every TerraX job.

Workers start with ``celery -A terrax.tasks worker``. With TERRAX_EAGER=true the
API runs jobs in its own process instead (no Redis needed).
"""

from __future__ import annotations

import logging
import time
import traceback

from celery import Celery

from . import storage
from .config import settings

log = logging.getLogger("terrax.jobs")

_s = settings()
celery_app = Celery("terrax", broker=_s.redis_url, backend=_s.redis_url)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_acks_late=True,  # a job is re-queued if its worker dies mid-run
    worker_prefetch_multiplier=1,  # long jobs: one at a time per worker process
    task_time_limit=60 * 30,
    task_soft_time_limit=60 * 25,
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
        return storage.update_job(job_id, state="done", progress=1.0, message="Done", seconds=round(time.time() - started, 2))
    except ToolError as err:
        return storage.update_job(job_id, state="error", message=str(err), error=str(err))
    except ValueError as err:  # data problems raised by the processing modules
        return storage.update_job(job_id, state="error", message=str(err), error=str(err))
    except Exception as err:  # noqa: BLE001 — record any failure so the UI stops waiting
        log.exception("job %s failed", job_id)
        msg = f"The analysis failed unexpectedly ({type(err).__name__}: {err})."
        return storage.update_job(job_id, state="error", message=msg, error=msg, trace=traceback.format_exc()[-4000:])


@celery_app.task(name="terrax.run_job")
def run_job_task(job_id: str) -> dict:
    return run_job(job_id)


@celery_app.task(name="terrax.purge")
def purge_task() -> int:
    return storage.purge_old()


def submit(job_id: str) -> None:
    """Queues a job on the workers, or runs it right away in eager mode."""
    if settings().eager:
        run_job(job_id)
    else:
        run_job_task.delay(job_id)
