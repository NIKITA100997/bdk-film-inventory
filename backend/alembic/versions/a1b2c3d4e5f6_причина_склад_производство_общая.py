"""Причины брака/списания — категория (склад/производство/общая)

Revision ID: a1b2c3d4e5f6
Revises: 7393d0901c8c
Create Date: 2026-08-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '7393d0901c8c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Раздел про модуль "Брак и списания" — существующий общий справочник
# причин (write_off_reasons) не разделяется на два (склад/производство),
# получает только это поле: пикер на списании единицы просит category
# warehouse+general, пикер брака на производстве — production+general.
# Классификация того, что уже реально существовало на момент миграции —
# ни одна из текущих причин не была специфична для цеха, это ожидаемо
# (см. открытый пункт 12.6 бэклога — производство пока переиспользует
# складской список); новые причины, специфичные для производства,
# заводятся руками через "+Добавить причину" уже с нужной категорией.
_CATEGORY_BY_CODE = {
    "warehouse_damage": "warehouse",
    "wrong_grade": "warehouse",
    "cutting_waste": "warehouse",
    "supplier_defect": "general",
    "other": "general",
}


def upgrade() -> None:
    op.add_column(
        "write_off_reasons",
        sa.Column("category", sa.String(length=20), nullable=False, server_default="general"),
    )
    conn = op.get_bind()
    for code, category in _CATEGORY_BY_CODE.items():
        conn.execute(
            sa.text("UPDATE write_off_reasons SET category = :category WHERE code = :code"),
            {"category": category, "code": code},
        )


def downgrade() -> None:
    op.drop_column("write_off_reasons", "category")
