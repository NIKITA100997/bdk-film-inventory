"""Шаблон импорта графика у типа изделия (вместо разбора щитовых в коде)

Revision ID: e5b7d9f1a3c4
Revises: d4a6c8e0f2b3
Create Date: 2026-10-03 15:00:00.000000

Щитовой двери ставится шаблон, повторяющий прежний разбор: колонки листа
«График», цвет из наименования, кромка/стекло/молдинг/замок — правилами.
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5b7d9f1a3c4'
down_revision: Union[str, Sequence[str], None] = 'd4a6c8e0f2b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SHIELD_TEMPLATE = {
    "columns": [
        {"title": "Дата отгрузки", "role": "ship_date"},
        {"title": "№ счёта", "role": "invoice"},
        {"title": "Серия", "role": "property", "code": "серия"},
        {"title": "Размер", "role": "size", "codes": ["ширина", "высота"]},
        {"title": "Цвет", "role": "property", "code": "цвет", "from_name": True},
        {"title": "Наименование", "role": "name"},
        {"title": "Кол-во дверей", "role": "qty"},
    ],
    "defaults": [
        {"code": "кромка", "from": "серия.кромка", "fallback": "abs"},
    ],
    "rules": [
        {"code": "цвет_кромки", "pattern": r"кромка\s+(?!с\s|\d)(.+?)(?=\s*(?:молдинг|кромка|\(|\)|$))", "capture": 1, "take": "last"},
        {"code": "кромка", "source": "цвет_кромки", "pattern": r"^(black|silver)$", "value": "aluminum"},
        {"code": "кромка", "source": "цвет_кромки", "pattern": r"abs|пэт|\d\s*мм", "value": "abs"},
        {"code": "стекло", "pattern": r"стекл", "value": "есть"},
        {"code": "стекло", "pattern": r"\bстекло\s+([^()]+?)\s*(?=\)|\s+кромк|\s+молдинг|$)", "capture": 1},
        {"code": "молдинг", "pattern": r"молдинг|\(м\d"},
        {"code": "замок", "pattern": r"защ[её]лк|pl\s*410"},
    ],
}
NEED = ("серия", "ширина", "высота", "цвет", "стекло", "молдинг", "замок", "кромка", "цвет_кромки")


def upgrade() -> None:
    op.add_column("item_types", sa.Column("import_template", sa.JSON(), nullable=True))
    conn = op.get_bind()
    for (type_id,) in conn.execute(sa.text("SELECT id FROM item_types WHERE name = 'Щитовая дверь'")).all():
        codes = {r[0] for r in conn.execute(sa.text("SELECT code FROM item_properties WHERE type_id = :t"), {"t": type_id})}
        if all(c in codes for c in NEED):
            conn.execute(
                sa.text("UPDATE item_types SET import_template = CAST(:j AS json) WHERE id = :t"),
                {"j": json.dumps(SHIELD_TEMPLATE, ensure_ascii=False), "t": type_id},
            )


def downgrade() -> None:
    op.drop_column("item_types", "import_template")
