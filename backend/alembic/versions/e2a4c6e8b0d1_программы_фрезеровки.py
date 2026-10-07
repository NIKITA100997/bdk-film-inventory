"""Справочник программ фрезеровки и исходная строка графика у строки заказа

Revision ID: e2a4c6e8b0d1
Revises: d1f3b5a7c9e0
Create Date: 2026-10-07 18:00:00.000000

Программы — из листа «Данные для формул» Excel-монитора запуска 16.09.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e2a4c6e8b0d1'
down_revision: Union[str, Sequence[str], None] = 'd1f3b5a7c9e0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PROGRAMS = "А1|А2|А3|А4|А5|А6|А7|А8|А9|А10|В1_F2_600х2000|В1_F2_700х2000|В1_F2_800х2000|В1_F2_900х2000|В5_F3_600х2000_1|В5_F3_600х2000_2|В5_F3_700х2000_1|В5_F3_700х2000_2|В5_F3_800х2000_1|В5_F3_800х2000_2|В5_F3_900х2000_1|В5_F3_900х2000_2|В5_F4_600х2000_1|В5_F4_600х2000_2|В5_F4_700х2000_1|В5_F4_700х2000_2|В5_F4_800х2000_1|В5_F4_800х2000_2|В5_F4_900х2000_1|В5_F4_900х2000_2|В9х2000|В10.1_600х2000_(М5х3)|В10.1_700х2000_(М5х3)|В10.1_800х2000_(М5х3)|В10.1_900х2000_(М5х3)|В10.2_600х2000_(М5х3)|В10.2_700х2000_(М5х3)|В10.2_800х2000_(М5х3)|В10.2_900х2000_(М5х3)|В-11х2000|В12х2000|В13.1_(М5х3)|В13.2_(М5х3)|В14_(М9)|В14.1_(М5х3)|В14.2_(М5х3)|В15.1_600х2000_(М5х3)|В15.1_700х2000_(М5х3)|В15.1_800х2000_(М5х3)|В15.1_900х2000_(М5х3)|В15.2_600х2000_(М5х3)|В15.2_700х2000_(М5х3)|В15.2_800х2000_(М5х3)|В15.2_900х2000_(М5х3)|В15_600х2000_(М9)|В15_700х2000_(М9)|В15_800х2000_(М9)|В15_900х2000_(М9)|В15_600х2000_(М6)|В15_700х2000_(М6)|В15_800х2000_(М6)|В15_900х2000_(М6)|В16.2_(М5х3/М3х3)|В19.1_(М5х3)|В19.2_(М5х3)|Е10.2_(М5х3)|Е13.2_(М5х3)|Е14.2_(М5х3)|Е15.2_(М5х3)|Е16.2_(М5х3/М3х3)_1|Е16.2_(М5х3/М3х3)_2|Е17.2_(М5х3)|Е19.2_(М5х3)|Grafiti_2_600х2000|Grafiti_2_700х2000|Grafiti_2_800х2000|Grafiti_2_900х2000|Grafiti_5_600х2000_1|Grafiti_5_600х2000_2|Grafiti_5_700х2000_1|Grafiti_5_700х2000_2|Grafiti_5_800х2000_1|Grafiti_5_800х2000_2|Grafiti_5_900х2000_1|Grafiti_5_900х2000_2".split("|")


def upgrade() -> None:
    t = op.create_table(
        "milling_programs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(128), nullable=False, unique=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.bulk_insert(t, [{"name": n, "note": "Excel, запуск 16.09"} for n in PROGRAMS])
    op.add_column("production_order_lines", sa.Column("source_text", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("production_order_lines", "source_text")
    op.drop_table("milling_programs")
