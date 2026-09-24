"""Единая модель, пункт 3: маршрут у любой позиции номенклатуры, не только
у детали п/ф. part_stages получает item_id (заполняется из parts.item_id),
part_id становится необязательным — у изделия операции без детали. id
этапов не меняются: партии п/ф, их события и строки заданий остаются на
своих этапах.

Revision ID: f5c8d2e1a7b3
Revises: e3b7c1d9f4a6
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f5c8d2e1a7b3"
down_revision: Union[str, Sequence[str], None] = "e3b7c1d9f4a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("part_stages", sa.Column("item_id", sa.Integer(), sa.ForeignKey("items.id"), nullable=True))
    op.execute("UPDATE part_stages s SET item_id = p.item_id FROM parts p WHERE p.id = s.part_id")
    missing = op.get_bind().execute(sa.text("SELECT count(*) FROM part_stages WHERE item_id IS NULL")).scalar()
    if missing:
        raise RuntimeError(f"{missing} этапов без позиции номенклатуры — у их деталей нет item_id")
    op.alter_column("part_stages", "item_id", existing_type=sa.Integer(), nullable=False)
    op.create_index("ix_part_stages_item_id", "part_stages", ["item_id"])
    op.create_unique_constraint("uq_part_stage_item_order", "part_stages", ["item_id", "sequence_order"])
    op.alter_column("part_stages", "part_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    n = op.get_bind().execute(sa.text("SELECT count(*) FROM part_stages WHERE part_id IS NULL")).scalar()
    if n:
        raise RuntimeError(f"{n} операций у изделий без детали — откат их потерял бы")
    op.alter_column("part_stages", "part_id", existing_type=sa.Integer(), nullable=False)
    op.drop_constraint("uq_part_stage_item_order", "part_stages", type_="unique")
    op.drop_index("ix_part_stages_item_id", table_name="part_stages")
    op.drop_column("part_stages", "item_id")
