"""Явный тип единицы (рулон/штрипс) + переименование видов макета этикетки

Revision ID: 7393d0901c8c
Revises: c2b2cfeac372
Create Date: 2026-08-18 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7393d0901c8c'
down_revision: Union[str, Sequence[str], None] = 'c2b2cfeac372'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Раздел про приёмку отдельных штрипсов — раньше рулон/штрипс только
    выводился на лету (родная ширина позиции материала либо наличие
    parent_id), явного поля не было, поэтому при приёмке нельзя было
    напрямую указать, что это штрипс. Бэкфилл существующих строк — той же
    логикой, что использовал определявший тип стеллажа
    services/placement.py::determine_rack_type до этой миграции, чтобы уже
    размещённые единицы не сменили тип задним числом."""
    op.add_column(
        "material_units",
        sa.Column("is_strip", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        """
        UPDATE material_units mu
        SET is_strip = CASE
            WHEN ms.native_width_mm IS NOT NULL THEN ABS(ms.native_width_mm - mu.width_mm) >= 0.01
            ELSE mu.parent_id IS NOT NULL
        END
        FROM material_skus ms
        WHERE mu.material_sku_id = ms.id
        """
    )

    # Раздел про отдельные макеты для рулонов/штрипсов/стеллажей — старые
    # виды "unit"/"rack" переименовываются в "roll"/"rack_roll" (сохраняя
    # уже настроенные оператором макеты), виды "strip"/"rack_strip"/
    # "cutting_issue" создаются заново при первом обращении (тот же приём
    # автосоздания по умолчанию, что уже есть в _get_template).
    op.execute("UPDATE label_templates SET kind = 'roll' WHERE kind = 'unit'")
    op.execute("UPDATE label_templates SET kind = 'rack_roll' WHERE kind = 'rack'")


def downgrade() -> None:
    op.execute("UPDATE label_templates SET kind = 'unit' WHERE kind = 'roll'")
    op.execute("UPDATE label_templates SET kind = 'rack' WHERE kind = 'rack_roll'")
    op.execute("DELETE FROM label_templates WHERE kind IN ('strip', 'rack_strip', 'cutting_issue')")
    op.drop_column("material_units", "is_strip")
