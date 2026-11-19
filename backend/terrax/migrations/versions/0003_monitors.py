"""Forest-loss monitoring: watched areas and their alerts.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-19
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "monitors",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("geojson", sa.JSON(), nullable=False),
        sa.Column("bbox", sa.JSON(), nullable=False),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("email", sa.Boolean(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("reference", sa.JSON()),
        sa.Column("last_scene", sa.String(40)),
        sa.Column("last_checked", sa.Float()),
        sa.Column("next_check", sa.Float(), nullable=False),
        sa.Column("status", sa.String(500), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("updated", sa.Float(), nullable=False),
    )
    op.create_index("ix_monitors_owner", "monitors", ["owner"])
    op.create_table(
        "monitor_alerts",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("monitor_id", sa.String(32), sa.ForeignKey("monitors.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("first_seen", sa.String(10), nullable=False),
        sa.Column("confirmed", sa.String(10), nullable=False),
        sa.Column("area_ha", sa.Float(), nullable=False),
        sa.Column("patches", sa.Integer(), nullable=False),
        sa.Column("geojson", sa.JSON(), nullable=False),
        sa.Column("emailed", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_monitor_alerts_monitor_id", "monitor_alerts", ["monitor_id"])


def downgrade() -> None:
    op.drop_table("monitor_alerts")
    op.drop_table("monitors")
