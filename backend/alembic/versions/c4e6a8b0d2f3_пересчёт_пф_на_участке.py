"""Пересчёт п/ф на участке (инвентаризация п/ф) и право на него

Revision ID: c4e6a8b0d2f3
Revises: b3d5f7a9c1e2
Create Date: 2026-10-06 12:00:00.000000

Право «Пересчёт п/ф на участке» выдаётся ролям с users.manage, дальше —
через «Роли».
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4e6a8b0d2f3'
down_revision: Union[str, Sequence[str], None] = 'b3d5f7a9c1e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

permissions_table = sa.table("permissions", sa.column("code", sa.String), sa.column("name", sa.String), sa.column("section", sa.String))
PERMS = [("part_units.count", "Пересчёт п/ф на участке (инвентаризация п/ф)", "Производство")]


def upgrade() -> None:
    op.create_table(
        "part_count_sessions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("area", sa.String(128), sa.ForeignKey("areas.code"), nullable=False, index=True),
        sa.Column("scope", sa.JSON, nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="in_progress"),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("started_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("closed_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "part_count_lines",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("session_id", sa.Integer, sa.ForeignKey("part_count_sessions.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("part_unit_id", sa.Integer, sa.ForeignKey("part_units.id"), nullable=True),
        sa.Column("part_id", sa.Integer, sa.ForeignKey("parts.id"), nullable=False),
        sa.Column("stage_id", sa.Integer, sa.ForeignKey("part_stages.id"), nullable=False),
        sa.Column("expected_qty", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("counted_qty", sa.Numeric(12, 2), nullable=True),
        sa.Column("counted_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("counted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision", sa.String(16), nullable=True),
        sa.Column("reason", sa.String(64), sa.ForeignKey("write_off_reasons.code"), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("resolved_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_part_unit_id", sa.Integer, sa.ForeignKey("part_units.id"), nullable=True),
    )
    op.bulk_insert(permissions_table, [{"code": c, "name": n, "section": s} for c, n, s in PERMS])
    for code, _, _ in PERMS:
        op.execute(f"""
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT rp.role_id, (SELECT id FROM permissions WHERE code = '{code}')
            FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
            WHERE p.code = 'users.manage'
        """)


def downgrade() -> None:
    for code, _, _ in PERMS:
        op.execute(f"DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = '{code}')")
        op.execute(f"DELETE FROM permissions WHERE code = '{code}'")
    op.drop_table("part_count_lines")
    op.drop_table("part_count_sessions")
