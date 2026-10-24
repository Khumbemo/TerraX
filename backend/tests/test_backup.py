"""Database backups: consistent dumps, restore (also into another database), rotation, the schedule and the CLI."""

import gzip
import json
import time

import pytest
from sqlalchemy import create_engine, func, select


@pytest.fixture()
def folder(tmp_path, monkeypatch):
    monkeypatch.setenv("TERRAX_BACKUP_DIR", str(tmp_path / "backups"))
    monkeypatch.delenv("TERRAX_S3_BUCKET", raising=False)
    return tmp_path / "backups"


def counts(eng=None):
    from terrax import backup, db

    eng = eng or db.engine()
    with eng.connect() as c:
        return {t.name: c.execute(select(func.count()).select_from(t)).scalar_one() for t in backup.tables()}


def account(client, email):
    r = client.post("/api/auth/signup", json={"email": email, "password": "correct horse battery", "name": "B"})
    assert r.status_code == 201, r.text
    return r.json()


def test_backup_and_restore_round_trip(client, folder):
    from terrax import backup, db

    email = f"backup.{time.time_ns()}@example.org"
    user = account(client, email)
    assert client.post("/api/projects", json={"name": "Kohima plots", "data": {"version": 1, "notes": "ünïcode"}}).status_code == 201
    with db.connect() as c:
        for _ in range(2):
            c.execute(db.audit.insert().values(at=time.time(), action="test.before_backup"))
    made = backup.create()
    assert (folder / made["name"]).is_file() and made["rows"] == counts()
    with gzip.open(folder / made["name"], "rt", encoding="utf-8") as f:
        header = json.loads(f.readline())
    assert header["format"] == "terrax-backup" and header["revision"] and "rate_counters" not in header["tables"]

    with db.connect() as c:  # lose the account and everything that hangs off it
        c.execute(db.users.delete().where(db.users.c.id == user["user"]["id"]))
        if c.dialect.name == "postgresql":  # as in a new database: the id sequences start again at 1
            for t in ("audit", "errors", "recovery_codes"):
                c.exec_driver_sql(f"ALTER SEQUENCE {t}_id_seq RESTART WITH 1")
    assert counts() != made["rows"]
    restored = backup.load(backup.read(made["name"]))
    assert restored == made["rows"] == counts()
    with db.connect() as c:
        u = c.execute(select(db.users).where(db.users.c.email == email)).first()
        p = c.execute(select(db.projects).where(db.projects.c.owner == u.id)).first()
    assert u is not None and p.data["notes"] == "ünïcode"
    with db.connect() as c:  # new rows still get ids (PostgreSQL's sequences were moved past the restored rows)
        for _ in range(2):
            c.execute(db.audit.insert().values(at=time.time(), action="test.after_restore"))


def test_restore_into_a_new_database_of_another_kind(client, folder, tmp_path):
    """A logical backup: whatever the server's database, it restores into a fresh SQLite file."""
    from terrax import backup, db

    account(client, f"copy.{time.time_ns()}@example.org")
    data, header = backup.dump()
    other = create_engine(f"sqlite:///{tmp_path / 'other.db'}")
    db._migrate(other)
    assert backup.load(data, other) == header["tables"] == counts(other)
    other.dispose()


def test_restore_if_empty_only_touches_an_empty_database(client, folder, tmp_path):
    from terrax import backup, db

    account(client, f"empty.{time.time_ns()}@example.org")
    made = backup.create()
    fresh = create_engine(f"sqlite:///{tmp_path / 'fresh.db'}")
    db._migrate(fresh)
    assert backup.restore_if_empty(fresh) == made["rows"]
    assert backup.restore_if_empty(fresh) is None  # no longer empty: left alone
    fresh.dispose()


def test_rotation_and_schedule(folder, monkeypatch):
    from terrax import backup

    monkeypatch.setenv("TERRAX_BACKUP_KEEP", "2")
    monkeypatch.setenv("TERRAX_BACKUP_HOURS", "6")
    assert backup.due()
    real = time.time
    names = []
    for i in range(3):
        monkeypatch.setattr(backup.time, "time", lambda i=i: real() + i * 7 * 3600)
        names.append(backup.create()["name"])
    monkeypatch.setattr(backup.time, "time", real)
    assert [b["name"] for b in backup.list_backups()] == names[:0:-1]  # newest two, newest first
    newest = backup.list_backups()[0]["created"]
    assert not backup.due(now=newest + 3600) and backup.due(now=newest + 6 * 3600)
    monkeypatch.setenv("TERRAX_BACKUP_HOURS", "0")
    assert not backup.due()


def test_bad_backups_are_refused(folder, tmp_path):
    from terrax import backup

    bad = tmp_path / "x.jsonl.gz"
    bad.write_bytes(gzip.compress(b'{"format": "something-else"}\n'))
    with pytest.raises(ValueError, match="not a TerraX database backup"):
        backup.load(bad.read_bytes())
    data, header = backup.dump()
    lines = gzip.decompress(data).decode().splitlines()
    newer = json.dumps({**header, "revision": "9999"})
    with pytest.raises(ValueError, match="unknown to this TerraX"):
        backup.load(gzip.compress(("\n".join([newer, *lines[1:]]) + "\n").encode()))
    if len(lines) > 1:
        with pytest.raises(ValueError, match="incomplete"):
            backup.load(gzip.compress(("\n".join(lines[:-1]) + "\n").encode()))
    with pytest.raises(KeyError):
        backup.read("../../etc/passwd")


def test_backups_go_to_the_bucket_when_there_is_one(monkeypatch):
    moto = pytest.importorskip("moto")
    from terrax import backup, objectstore

    for k, v in {"AWS_ACCESS_KEY_ID": "t", "AWS_SECRET_ACCESS_KEY": "t", "AWS_DEFAULT_REGION": "us-east-1", "TERRAX_S3_BUCKET": "terrax-bk"}.items():
        monkeypatch.setenv(k, v)
    with moto.mock_aws():
        objectstore._client.cache_clear()
        objectstore.client().create_bucket(Bucket="terrax-bk")
        made = backup.create()
        assert objectstore.list_keys("backups/") == [f"backups/{made['name']}"]
        assert backup.list_backups()[0]["name"] == made["name"]
        assert backup.load(backup.read(made["name"])) == made["rows"]
    objectstore._client.cache_clear()


def test_manage_commands(folder, capsys):
    from terrax import manage

    assert manage.main(["backup"]) == 0
    name = capsys.readouterr().out.split(" to ")[1].split(" ")[0]
    manage.main(["backups"])
    assert name in capsys.readouterr().out
    with pytest.raises(SystemExit, match="--yes"):
        manage.main(["restore", name])
    with pytest.raises(SystemExit, match="no backup"):
        manage.main(["restore", "terrax-db-20000101T000000Z.jsonl.gz", "--yes"])
    assert manage.main(["restore", name, "--yes"]) == 0
    assert "Restored" in capsys.readouterr().out


def test_an_empty_database_waits_for_unreadable_backups(folder, tmp_path, monkeypatch):
    """With TERRAX_BACKUP_RESTORE_EMPTY, an unreachable backup store stops the database from opening (no request
    is served on an empty database, and no backup of it rotates the good ones away); once it answers, the next use
    restores."""
    from terrax import backup, db

    made = backup.create()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'wiped.db'}")
    monkeypatch.setenv("TERRAX_BACKUP_RESTORE_EMPTY", "true")
    real = backup.list_backups

    def unreachable():
        raise ConnectionError("bucket unreachable")

    monkeypatch.setattr(backup, "list_backups", unreachable)
    with pytest.raises(ConnectionError):
        db.engine()
    monkeypatch.setattr(backup, "list_backups", real)
    try:
        assert counts(db.engine()) == made["rows"]
    finally:
        db._engines.pop(db.database_url()).dispose()
