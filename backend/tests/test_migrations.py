"""Alembic migrations: a fresh database, a database made before Alembic, and migrations matching db.metadata."""

import pytest
from sqlalchemy import create_engine, inspect, text


def _upgrade(url: str, rev: str) -> None:
    from alembic import command

    from terrax import db

    eng = create_engine(url)
    with eng.begin() as c:
        command.upgrade(db.alembic_config(c), rev)
    eng.dispose()


def test_a_pre_alembic_database_is_stamped_and_upgraded(tmp_path, monkeypatch):
    from terrax import db

    url = f"sqlite:///{tmp_path / 'old.db'}"
    _upgrade(url, "0001")  # the schema TerraX made with create_all before Alembic …
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text("DROP TABLE alembic_version"))  # … which had no alembic_version
        c.execute(text("INSERT INTO schema_version (version, applied) VALUES (1, 0)"))
        c.execute(text("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u1', 'old@example.org', '', 'x', 'user', 0, 0)"))
    eng.dispose()
    monkeypatch.setenv("DATABASE_URL", url)
    new = db.engine()
    tables = set(inspect(new).get_table_names())
    assert {"tokens", "audit", "rate_counters", "recovery_codes", "oidc_states", "alembic_version"} <= tables and "schema_version" not in tables
    with new.connect() as c:
        assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0002"
        # the existing account is kept and counts as verified
        assert c.execute(text("SELECT email, email_verified FROM users")).one() == ("old@example.org", True)


def test_migrations_create_exactly_the_tables_the_code_uses(tmp_path):
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    from terrax import db

    url = f"sqlite:///{tmp_path / 'fresh.db'}"
    _upgrade(url, "head")
    eng = create_engine(url)
    with eng.connect() as c:
        diff = compare_metadata(MigrationContext.configure(c), db.metadata)
    eng.dispose()
    assert diff == [], diff


def test_downgrade_and_upgrade_again(tmp_path):
    from alembic import command

    from terrax import db

    url = f"sqlite:///{tmp_path / 'round.db'}"
    _upgrade(url, "head")
    eng = create_engine(url)
    with eng.begin() as c:
        command.downgrade(db.alembic_config(c), "0001")
    with eng.begin() as c:
        assert "tokens" not in inspect(c).get_table_names()
        command.upgrade(db.alembic_config(c), "head")
    with eng.connect() as c:
        assert "tokens" in inspect(c).get_table_names()
    eng.dispose()


@pytest.mark.parametrize("cmd", ["status", "upgrade"])
def test_manage_migrate(cmd, capsys):
    from terrax import manage

    assert manage.main(["migrate", cmd]) == 0
    assert "0002" in capsys.readouterr().out
