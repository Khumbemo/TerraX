"""Alembic environment for TerraX: the connection comes from terrax.db (or DATABASE_URL), the tables from db.metadata."""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine

from terrax import db

config = context.config
target_metadata = db.metadata


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:  # called from terrax.db, inside its transaction
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=connection.dialect.name == "sqlite")
        context.run_migrations()
        return
    engine = create_engine(db.database_url())
    with engine.begin() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, render_as_batch=conn.dialect.name == "sqlite")
        context.run_migrations()


def run_migrations_offline() -> None:
    context.configure(url=db.database_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
