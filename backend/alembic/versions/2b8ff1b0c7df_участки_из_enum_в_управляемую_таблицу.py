"""участки из enum в управляемую таблицу

Revision ID: 2b8ff1b0c7df
Revises: 2a412ca3cfeb
Create Date: 2026-08-14 13:03:57.247235

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2b8ff1b0c7df'
down_revision: Union[str, Sequence[str], None] = '2a412ca3cfeb'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Таблицы, у которых колонка area переходит с enum-типа на строку с FK на
# areas.code, и была ли она nullable (для отката).
_AREA_TABLES = [
    ("users", True),
    ("material_units", True),
    ("material_events", True),
    ("production_lines", False),
    ("product_models", False),
    ("product_model_parts", False),
    ("production_tasks", False),
]

_SEED_AREAS = [
    ("okutka_tsargovykh", "Окутка царговых"),
    ("shchitovye_dveri", "Щитовые двери"),
    ("tselnolistovye_dveri", "Цельнолистовые двери"),
]


def upgrade() -> None:
    """Upgrade schema."""
    areas_table = op.create_table(
        "areas",
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("code"),
        sa.UniqueConstraint("name"),
    )
    op.bulk_insert(
        areas_table,
        [{"code": code, "name": name, "is_active": True} for code, name in _SEED_AREAS],
    )

    for table, nullable in _AREA_TABLES:
        # В БД enum хранится по ИМЕНИ члена ('OKUTKA_TSARGOVYKH' —
        # стандартное поведение sa.Enum(PyEnum) без values_callable), а не
        # по значению ("okutka_tsargovykh", то, что видит API/фронтенд) —
        # lower() приводит к новому code без ручного бэкофилла.
        op.execute(f"ALTER TABLE {table} ALTER COLUMN area TYPE VARCHAR(64) USING lower(area::text)")
        op.create_foreign_key(f"{table}_area_fkey", table, "areas", ["area"], ["code"])

    # DROP TYPE — после того как все 7 колонок отвязаны от старого enum-типа.
    op.execute("DROP TYPE area")


def downgrade() -> None:
    """Downgrade schema."""
    # Те же лейблы, что были у типа изначально (ef7b0d238d02_initial_schema.py)
    # — по ИМЕНИ члена enum, не по значению (см. комментарий в upgrade()).
    op.execute(
        "CREATE TYPE area AS ENUM ('OKUTKA_TSARGOVYKH', 'SHCHITOVYE_DVERI', 'TSELNOLISTOVYE_DVERI')"
    )

    for table, nullable in _AREA_TABLES:
        op.drop_constraint(f"{table}_area_fkey", table, type_="foreignkey")
        op.execute(f"ALTER TABLE {table} ALTER COLUMN area TYPE area USING upper(area)::area")

    op.drop_table("areas")
