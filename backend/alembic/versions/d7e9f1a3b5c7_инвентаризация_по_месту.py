"""инвентаризация по месту (27.10)

Пересчёт п/ф на участке становится единой инвентаризацией: место — участок,
склад плёнки, склад материалов или склад ГП площадки; в листе — всё, что там
по учёту, любого вида (плёнка по рулонам, п/ф по партиям, материалы и
изделия по позиции). Таблицы те же — начатые пересчёты п/ф сохраняются.

Revision ID: d7e9f1a3b5c7
Revises: c4afcdd1fae0
Create Date: 2026-10-27 18:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

revision = "d7e9f1a3b5c7"
down_revision = "c4afcdd1fae0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("part_count_sessions", sa.Column("place_type", sa.String(16), nullable=False, server_default="area"))
    op.add_column("part_count_sessions", sa.Column("place_ref", sa.String(64), nullable=True))
    op.alter_column("part_count_sessions", "area", existing_type=sa.String(), nullable=True)

    op.add_column("part_count_lines", sa.Column("kind", sa.String(16), nullable=False, server_default="pf"))
    op.add_column("part_count_lines", sa.Column("item_id", sa.Integer(), sa.ForeignKey("items.id"), nullable=True))
    op.add_column(
        "part_count_lines", sa.Column("material_unit_id", sa.Integer(), sa.ForeignKey("material_units.id"), nullable=True)
    )
    op.add_column("part_count_lines", sa.Column("site_id", sa.Integer(), sa.ForeignKey("sites.id"), nullable=True))
    op.alter_column("part_count_lines", "part_id", existing_type=sa.Integer(), nullable=True)
    op.alter_column("part_count_lines", "stage_id", existing_type=sa.Integer(), nullable=True)
    op.alter_column("part_count_lines", "expected_qty", existing_type=sa.Numeric(12, 2), type_=sa.Numeric(14, 3))
    op.alter_column("part_count_lines", "counted_qty", existing_type=sa.Numeric(12, 2), type_=sa.Numeric(14, 3))


def downgrade() -> None:
    op.alter_column("part_count_lines", "counted_qty", existing_type=sa.Numeric(14, 3), type_=sa.Numeric(12, 2))
    op.alter_column("part_count_lines", "expected_qty", existing_type=sa.Numeric(14, 3), type_=sa.Numeric(12, 2))
    op.drop_column("part_count_lines", "site_id")
    op.drop_column("part_count_lines", "material_unit_id")
    op.drop_column("part_count_lines", "item_id")
    op.drop_column("part_count_lines", "kind")
    op.drop_column("part_count_sessions", "place_ref")
    op.drop_column("part_count_sessions", "place_type")
