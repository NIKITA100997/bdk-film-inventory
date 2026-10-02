"""Участок: плёнку режут на участке (выдача рулоном целиком)

Revision ID: b8e3f1a2c4d6
Revises: a7d2e4f6b813
Create Date: 2026-10-02 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b8e3f1a2c4d6'
down_revision: Union[str, Sequence[str], None] = 'a7d2e4f6b813'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("areas", sa.Column("film_cut_on_site", sa.Boolean(), nullable=False, server_default="false"))
    # Мембранно-вакуумные прессы режут плёнку в размер вручную (решение 02.10).
    op.execute("UPDATE areas SET film_cut_on_site = true WHERE code = 'uchastok_membranno_vakuumnykh_pressov'")


def downgrade() -> None:
    op.drop_column("areas", "film_cut_on_site")
