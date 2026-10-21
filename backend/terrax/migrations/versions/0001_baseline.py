"""Baseline: the schema TerraX created before Alembic (accounts, sessions, files, jobs, projects, errors).

Revision ID: 0001
Revises:
Create Date: 2026-10-21
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("email", sa.String(254), nullable=False, unique=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("disabled", sa.Boolean(), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("last_login", sa.Float()),
    )
    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("expires", sa.Float(), nullable=False),
        sa.Column("last_seen", sa.Float(), nullable=False),
        sa.Column("ip", sa.String(64), nullable=False),
        sa.Column("user_agent", sa.String(300), nullable=False),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_table(
        "files",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner", sa.String(70), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("sample", sa.Boolean(), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("expires", sa.Float()),
        sa.Column("purged", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_files_owner", "files", ["owner"])
    op.create_table(
        "jobs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner", sa.String(70), nullable=False),
        sa.Column("tool", sa.String(40), nullable=False),
        sa.Column("state", sa.String(12), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("inputs", sa.JSON(), nullable=False),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("updated", sa.Float(), nullable=False),
        sa.Column("seconds", sa.Float()),
        sa.Column("expires", sa.Float()),
        sa.Column("purged", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_jobs_owner_created", "jobs", ["owner", "created"])
    op.create_table(
        "projects",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("updated", sa.Float(), nullable=False),
    )
    op.create_index("ix_projects_owner", "projects", ["owner"])
    op.create_table(
        "project_shares",
        sa.Column("project_id", sa.String(32), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("can_edit", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "errors",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("at", sa.Float(), nullable=False),
        sa.Column("source", sa.String(12), nullable=False),
        sa.Column("kind", sa.String(120), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("path", sa.String(300), nullable=False),
        sa.Column("request_id", sa.String(40), nullable=False),
        sa.Column("owner", sa.String(70), nullable=False),
    )
    op.create_index("ix_errors_at", "errors", ["at"])
    op.create_table("schema_version", sa.Column("version", sa.Integer(), primary_key=True), sa.Column("applied", sa.Float(), nullable=False))


def downgrade() -> None:
    for t in ("schema_version", "errors", "project_shares", "projects", "jobs", "files", "sessions", "users"):
        op.drop_table(t)
