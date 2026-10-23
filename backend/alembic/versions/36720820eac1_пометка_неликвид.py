"""пометка «неликвид» у рулона и строка задания «из неликвида» (23.10)

Неликвид — не отдельный цвет, а пометка на рулоне основного цвета:
обычные задания его не берут, строка задания «из неликвида» — только его.

Revision ID: 36720820eac1
Revises: a831d1095a22
Create Date: 2026-10-23 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

revision = "36720820eac1"
down_revision = "a831d1095a22"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("material_units", sa.Column("marked_illiquid", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("production_task_lines", sa.Column("use_illiquid", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("production_task_lines", "use_illiquid")
    op.drop_column("material_units", "marked_illiquid")
