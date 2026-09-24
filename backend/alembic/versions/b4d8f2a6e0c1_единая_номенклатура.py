"""Единая номенклатура: виды, номенклатура, ссылки вместо связи по названию

Revision ID: b4d8f2a6e0c1
Revises: a7c3e9b1d5f2
Create Date: 2026-09-24 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b4d8f2a6e0c1'
down_revision: Union[str, Sequence[str], None] = 'a7c3e9b1d5f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_KINDS = [
    ("plenka", "Плёнка", "м", True, 1),
    ("pf", "П/ф", "шт", True, 2),
    ("izdelie", "Изделие", "шт", False, 3),
]

_NORM = "replace(lower(trim({})), 'ё', 'е')"


def upgrade() -> None:
    op.create_table(
        "item_kinds",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("unit", sa.String(length=16), nullable=False),
        sa.Column("lot_tracking", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("code_1c", sa.String(length=64), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["kind_id"], ["item_kinds.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_items_kind_id"), "items", ["kind_id"])
    op.create_index(op.f("ix_items_code_1c"), "items", ["code_1c"])

    for table in ("material_skus", "parts", "product_models"):
        op.add_column(table, sa.Column("item_id", sa.Integer(), nullable=True))
        op.create_foreign_key(f"fk_{table}_item_id", table, "items", ["item_id"], ["id"])
        op.create_unique_constraint(f"uq_{table}_item_id", table, ["item_id"])
    for table in ("product_model_parts", "production_task_lines"):
        op.add_column(table, sa.Column("part_id", sa.Integer(), nullable=True))
        op.create_foreign_key(f"fk_{table}_part_id", table, "parts", ["part_id"], ["id"])
        op.create_index(f"ix_{table}_part_id", table, ["part_id"])

    conn = op.get_bind()
    kind_ids = {}
    for code, name, unit, lots, order in _KINDS:
        kind_ids[code] = conn.execute(
            sa.text(
                "INSERT INTO item_kinds (code, name, unit, lot_tracking, sort_order, is_active) "
                "VALUES (:c, :n, :u, :l, :o, true) RETURNING id"
            ),
            {"c": code, "n": name, "u": unit, "l": lots, "o": order},
        ).scalar()

    def backfill(table: str, kind: str, rows) -> None:
        for row_id, name, active in rows:
            item_id = conn.execute(
                sa.text("INSERT INTO items (kind_id, name, is_active) VALUES (:k, :n, :a) RETURNING id"),
                {"k": kind_ids[kind], "n": name, "a": active},
            ).scalar()
            conn.execute(sa.text(f"UPDATE {table} SET item_id = :i WHERE id = :r"), {"i": item_id, "r": row_id})

    backfill(
        "material_skus",
        "plenka",
        conn.execute(
            sa.text(
                "SELECT s.id, m.name || ', ' || c.name || ', ' || trim(to_char(t.value_mm, 'FM999990.999')) "
                "|| ' мм, ' || mf.name, s.is_active "
                "FROM material_skus s JOIN materials m ON m.id = s.material_id JOIN colors c ON c.id = s.color_id "
                "JOIN thicknesses t ON t.id = s.thickness_id JOIN manufacturers mf ON mf.id = s.manufacturer_id "
                "ORDER BY s.id"
            )
        ).fetchall(),
    )
    backfill("parts", "pf", conn.execute(sa.text("SELECT id, name, is_active FROM parts ORDER BY id")).fetchall())
    backfill(
        "product_models", "izdelie",
        conn.execute(sa.text("SELECT id, name, is_active FROM product_models ORDER BY id")).fetchall(),
    )

    for table in ("product_model_parts", "production_task_lines"):
        conn.execute(
            sa.text(
                f"UPDATE {table} l SET part_id = (SELECT min(p.id) FROM parts p "
                f"WHERE {_NORM.format('p.name')} = {_NORM.format('l.part_name')}) "
                "WHERE l.part_name IS NOT NULL AND l.part_id IS NULL"
            )
        )


def downgrade() -> None:
    for table in ("product_model_parts", "production_task_lines"):
        op.drop_index(f"ix_{table}_part_id", table_name=table)
        op.drop_constraint(f"fk_{table}_part_id", table, type_="foreignkey")
        op.drop_column(table, "part_id")
    for table in ("material_skus", "parts", "product_models"):
        op.drop_constraint(f"uq_{table}_item_id", table, type_="unique")
        op.drop_constraint(f"fk_{table}_item_id", table, type_="foreignkey")
        op.drop_column(table, "item_id")
    op.drop_index(op.f("ix_items_code_1c"), table_name="items")
    op.drop_index(op.f("ix_items_kind_id"), table_name="items")
    op.drop_table("items")
    op.drop_table("item_kinds")
