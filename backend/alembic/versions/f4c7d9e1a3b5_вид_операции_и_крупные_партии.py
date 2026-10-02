"""Вид операции (с плёнкой / программа станка) и настройки участка: припуск плёнки, крупные партии

Revision ID: f4c7d9e1a3b5
Revises: e3b6c8d0f2a4
Create Date: 2026-10-03 10:00:00.000000

Заполнение — как было зашито в коде: «Ламинация»/«Окутка» — операции с
плёнкой, операции участка «Фрезеровка панелей» — с программой станка;
участок «Фабрика» — припуск 7 мм; ламинация панелей на прессах от 200 шт
предлагается на Фабрике.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f4c7d9e1a3b5'
down_revision: Union[str, Sequence[str], None] = 'e3b6c8d0f2a4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("part_stages", sa.Column("role", sa.String(16), nullable=True))
    op.add_column("item_type_operations", sa.Column("role", sa.String(16), nullable=True))
    op.add_column("areas", sa.Column("film_allowance_mm", sa.Numeric(10, 2), nullable=True))
    op.add_column("areas", sa.Column("big_batch_area", sa.String(128), sa.ForeignKey("areas.code"), nullable=True))
    op.add_column("areas", sa.Column("big_batch_min_pieces", sa.Numeric(10, 2), nullable=True))
    for t in ("part_stages", "item_type_operations"):
        op.execute(f"UPDATE {t} SET role = 'film' WHERE name IN ('Ламинация', 'Окутка')")
        op.execute(f"UPDATE {t} SET role = 'program' WHERE area = 'frezerovka_paneley' AND role IS NULL")
    op.execute("UPDATE areas SET film_allowance_mm = 7 WHERE code = 'fabrika'")
    op.execute(
        "UPDATE areas SET big_batch_area = 'fabrika', big_batch_min_pieces = 200 "
        "WHERE code IN (SELECT DISTINCT area FROM part_stages WHERE name = 'Ламинация' AND area IS NOT NULL) "
        "AND EXISTS (SELECT 1 FROM areas WHERE code = 'fabrika')"
    )


def downgrade() -> None:
    op.drop_column("areas", "big_batch_min_pieces")
    op.drop_column("areas", "big_batch_area")
    op.drop_column("areas", "film_allowance_mm")
    op.drop_column("item_type_operations", "role")
    op.drop_column("part_stages", "role")
