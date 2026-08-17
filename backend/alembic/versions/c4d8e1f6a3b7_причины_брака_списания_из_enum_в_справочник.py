"""Причины брака/списания из enum в справочник

Revision ID: c4d8e1f6a3b7
Revises: 9b2f7c4e8a1d
Create Date: 2026-08-17 00:00:00.000003

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4d8e1f6a3b7'
down_revision: Union[str, Sequence[str], None] = '9b2f7c4e8a1d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SEED_REASONS = [
    ("supplier_defect", "Брак поставщика", False),
    ("warehouse_damage", "Повреждение на складе", False),
    ("wrong_grade", "Пересорт", False),
    ("cutting_waste", "Отход при раскрое", True),
    ("other", "Другое", False),
]

_CONSUMERS = [
    ("material_events", "write_off_reason"),
    ("production_task_line_reports", "defect_reason"),
]


def upgrade() -> None:
    """Upgrade schema."""
    reasons_table = op.create_table(
        "write_off_reasons",
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("is_system", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("code"),
        sa.UniqueConstraint("name"),
    )
    op.bulk_insert(
        reasons_table,
        [{"code": code, "name": name, "is_active": True, "is_system": is_system} for code, name, is_system in _SEED_REASONS],
    )

    for table, col in _CONSUMERS:
        # В БД enum хранится по ИМЕНИ члена ('SUPPLIER_DEFECT'...), не по
        # значению — lower() приводит к новому code без ручного бэкофилла
        # (тот же приём, что миграция участков 2b8ff1b0c7df).
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {col} TYPE VARCHAR(64) USING lower({col}::text)")
        op.create_foreign_key(f"{table}_{col}_fkey", table, "write_off_reasons", [col], ["code"])

    op.execute("DROP TYPE write_off_reason")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("CREATE TYPE write_off_reason AS ENUM ('SUPPLIER_DEFECT', 'WAREHOUSE_DAMAGE', 'WRONG_GRADE', 'CUTTING_WASTE', 'OTHER')")
    for table, col in _CONSUMERS:
        op.drop_constraint(f"{table}_{col}_fkey", table, type_="foreignkey")
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {col} TYPE write_off_reason USING upper({col})::write_off_reason")
    op.drop_table("write_off_reasons")
