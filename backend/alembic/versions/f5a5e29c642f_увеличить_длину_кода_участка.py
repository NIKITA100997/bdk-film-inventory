"""увеличить длину кода участка

`areas.code` был String(64) — код генерируется транслитерацией названия
(services/areas.py::slugify), и для длинного описательного названия
участка (напр. "Участок ламинации наружних цельнолистовых панелей
металлических дверей" -> 77 символов транслитерацией) 64 символов не
хватало, создание участка падало с 500 (StringDataRightTruncation),
а не понятной ошибкой валидации. Увеличиваем до 128 — тот же запас, что
уже есть у similar кодовых полей в этом проекте.

Revision ID: f5a5e29c642f
Revises: 0c7660df34ae
Create Date: 2026-08-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f5a5e29c642f'
down_revision: Union[str, Sequence[str], None] = '0c7660df34ae'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_FK_TABLES = [
    "users",
    "material_units",
    "material_events",
    "production_lines",
    "product_models",
    "product_model_parts",
    "production_tasks",
]


def upgrade() -> None:
    op.alter_column("areas", "code", type_=sa.String(length=128), existing_type=sa.String(length=64))
    for table in _FK_TABLES:
        op.alter_column(table, "area", type_=sa.String(length=128), existing_type=sa.String(length=64))


def downgrade() -> None:
    for table in _FK_TABLES:
        op.alter_column(table, "area", type_=sa.String(length=64), existing_type=sa.String(length=128))
    op.alter_column("areas", "code", type_=sa.String(length=64), existing_type=sa.String(length=128))
