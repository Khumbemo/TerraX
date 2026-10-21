"""Security: e-mail verification, single sign-on, two-factor sign-in, one-time tokens, recovery codes, audit log,
shared rate-limit counters and sign-in states.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-21
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.add_column(sa.Column("email_verified", sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column("oidc_sub", sa.String(300)))
        b.add_column(sa.Column("totp_secret", sa.String(64)))
        b.add_column(sa.Column("totp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column("totp_last_step", sa.Integer()))
    op.create_index("ix_users_oidc_sub", "users", ["oidc_sub"], unique=True)
    # Accounts made before verification existed count as verified, so turning verification on does not lock them out.
    op.execute(sa.text("UPDATE users SET email_verified = :t").bindparams(t=True))
    op.create_table(
        "tokens",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("expires", sa.Float(), nullable=False),
        sa.Column("used", sa.Float()),
    )
    op.create_index("ix_tokens_user_id", "tokens", ["user_id"])
    op.create_table(
        "recovery_codes",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("used", sa.Float()),
    )
    op.create_index("ix_recovery_codes_user_id", "recovery_codes", ["user_id"])
    op.create_table(
        "audit",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("at", sa.Float(), nullable=False),
        sa.Column("actor", sa.String(32), nullable=False),
        sa.Column("actor_email", sa.String(254), nullable=False),
        sa.Column("action", sa.String(60), nullable=False),
        sa.Column("target", sa.String(254), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("ip", sa.String(64), nullable=False),
    )
    op.create_index("ix_audit_at", "audit", ["at"])
    op.create_index("ix_audit_action", "audit", ["action"])
    op.create_table(
        "rate_counters",
        sa.Column("key", sa.String(200), primary_key=True),
        sa.Column("window", sa.Integer(), primary_key=True),
        sa.Column("count", sa.Integer(), nullable=False),
    )
    op.create_table(
        "oidc_states",
        sa.Column("state_hash", sa.String(64), primary_key=True),
        sa.Column("nonce", sa.String(64), nullable=False),
        sa.Column("verifier", sa.String(128), nullable=False),
        sa.Column("guest", sa.String(70), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
    )
    op.drop_table("schema_version")  # replaced by alembic_version


def downgrade() -> None:
    op.create_table("schema_version", sa.Column("version", sa.Integer(), primary_key=True), sa.Column("applied", sa.Float(), nullable=False))
    for t in ("oidc_states", "rate_counters", "audit", "recovery_codes", "tokens"):
        op.drop_table(t)
    op.drop_index("ix_users_oidc_sub", "users")
    with op.batch_alter_table("users") as b:
        for c in ("totp_last_step", "totp_enabled", "totp_secret", "oidc_sub", "email_verified"):
            b.drop_column(c)
