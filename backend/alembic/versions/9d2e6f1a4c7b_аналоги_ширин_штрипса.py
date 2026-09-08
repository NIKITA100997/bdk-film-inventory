"""Аналоги ширин штрипса

Revision ID: 9d2e6f1a4c7b
Revises: 7c3f9a1e2b4d
Create Date: 2026-09-08 15:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9d2e6f1a4c7b'
down_revision: Union[str, Sequence[str], None] = '7c3f9a1e2b4d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Раздел про аналоги ширин при выдаче — группы взаимозаменяемых ширин
    # штрипса (290/285/287мм и т.п.), заводятся вручную, не автоматическим
    # допуском в мм.
    op.create_table(
        "width_analog_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("note", sa.String(length=255), nullable=True),
    )
    op.create_table(
        "width_analog_members",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("group_id", sa.Integer(), sa.ForeignKey("width_analog_groups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("width_mm", sa.Numeric(10, 2), nullable=False),
        sa.UniqueConstraint("width_mm", name="uq_width_analog_member_width"),
    )


def downgrade() -> None:
    op.drop_table("width_analog_members")
    op.drop_table("width_analog_groups")
