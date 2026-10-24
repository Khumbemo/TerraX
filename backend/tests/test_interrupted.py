"""Jobs orphaned by a restart or crash: no heartbeat for storage.STALE_S, so they are marked failed, not left running."""

import time

from sqlalchemy import select, update


def _age(jid: str, state: str, seconds: float) -> None:
    from terrax import db, storage

    storage.update_job(jid, state=state)
    with db.connect() as c:
        c.execute(update(db.jobs).where(db.jobs.c.id == jid).values(updated=time.time() - seconds))


def _row(jid: str):
    from terrax import db

    with db.connect() as c:
        return c.execute(select(db.jobs).where(db.jobs.c.id == jid)).first()


def test_orphaned_jobs_are_marked_failed_and_live_ones_are_not(client):
    from terrax import storage

    old = storage.STALE_S + 60
    dead_running = storage.create_job("terrain", {}, {}, owner="g:test")
    dead_queued = storage.create_job("terrain", {}, {}, owner="g:test")
    alive = storage.create_job("terrain", {}, {}, owner="g:test")
    recent = storage.create_job("terrain", {}, {}, owner="g:test")
    _age(dead_running, "running", old)
    _age(dead_queued, "queued", old)
    _age(alive, "running", old)
    _age(recent, "running", 10)
    storage.claim(alive)  # this process still has it: its heartbeat keeps it
    try:
        assert storage.heartbeat() == 1
        # Celery: queued jobs wait in Redis, which survives a restart, so only running ones count.
        first = set(storage.fail_stale(queued_too=False))
        second = set(storage.fail_stale(queued_too=True))
        assert dead_running in first and dead_queued not in first and dead_queued in second
        assert not {alive, recent} & (first | second)
    finally:
        storage.release(alive)
    for jid in (dead_running, dead_queued):
        st = storage.job_status(jid)
        assert st["state"] == "error" and "did not finish" in st["message"] and _row(jid).state == "error"
    assert _row(alive).state == "running" and _row(recent).state == "running"


def test_an_orphan_without_its_folder_is_still_recorded(client):
    import shutil

    from terrax import storage

    jid = storage.create_job("terrain", {}, {}, owner="g:test")
    _age(jid, "running", storage.STALE_S + 60)
    shutil.rmtree(storage.job_dir(jid))
    assert jid in storage.fail_stale(queued_too=True)
    assert _row(jid).state == "error" and "Run it again" in _row(jid).message
