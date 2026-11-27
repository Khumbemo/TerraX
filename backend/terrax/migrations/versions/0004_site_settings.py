"""Site settings changed by administrators in the Admin tab.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-27
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "site_settings",
        sa.Column("key", sa.String(60), primary_key=True),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated", sa.Float(), nullable=False),
        sa.Column("updated_by", sa.String(254), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("site_settings")
