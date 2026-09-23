"""Справочник серий щитовых дверей

Revision ID: e5a1c7f3b920
Revises: d3f7a2c9e1b4
Create Date: 2026-09-23 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5a1c7f3b920'
down_revision: Union[str, Sequence[str], None] = 'd3f7a2c9e1b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


door_series_table = sa.table(
    "door_series",
    sa.column("name", sa.String),
    sa.column("frame_thickness_mm", sa.Numeric),
    sa.column("panel_mdf_thickness_mm", sa.Numeric),
    sa.column("edge_type", sa.String),
    sa.column("is_active", sa.Boolean),
)

# Базовые серии — колонка «Серия» листа «Данные для формул» графиков запуска.
# Толщины (после шлифовки) — «Технологическая карта изготовления щитовых
# дверей»: каркас А 26 (А-10 — 22), В и Е 24, Н 26; щит 6 мм, у Н-1 ВО 8 мм.
# Кромка по умолчанию — по реальным наименованиям в графиках: В — ABS/ПЭТ
# кромкооблицовка, А/Е/Н — алюминиевый профиль («кромка Black/Silver»).
_SERIES = (
    [(n, 26, 6, "aluminum") for n in ["А-1", "А-2", "А-3", "А-5", "А-6", "А-7", "А-9"]]
    + [("А-10", 22, 6, "aluminum")]
    + [
        (n, 24, 6, "abs")
        for n in [
            "В-1/Ф2", "В-5", "В-5/Ф3", "В-5/Ф4", "В-9", "В-10", "В-11", "В-12", "В-13",
            "В-14", "В-15", "В-16", "В-19", "В-28", "В-34",
        ]
    ]
    + [(n, 24, 6, "aluminum") for n in ["Е-5", "Е-6", "Е-10", "Е-13", "Е-14", "Е-15", "Е-17", "Е-19"]]
    + [("Н-1 НО", 26, 6, "aluminum"), ("Н-1 ВО", 26, 8, "aluminum")]
)


def upgrade() -> None:
    op.create_table(
        "door_series",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("frame_thickness_mm", sa.Numeric(precision=6, scale=2), nullable=False),
        sa.Column("panel_mdf_thickness_mm", sa.Numeric(precision=6, scale=2), nullable=False),
        sa.Column("edge_type", sa.String(length=16), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sa.CheckConstraint("edge_type IN ('abs', 'aluminum')", name="ck_door_series_edge_type"),
    )
    op.bulk_insert(
        door_series_table,
        [
            {"name": n, "frame_thickness_mm": f, "panel_mdf_thickness_mm": p, "edge_type": e, "is_active": True}
            for n, f, p, e in _SERIES
        ],
    )


def downgrade() -> None:
    op.drop_table("door_series")
