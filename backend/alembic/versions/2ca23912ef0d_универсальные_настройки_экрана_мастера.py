"""универсальные_настройки_экрана_мастера

Revision ID: 2ca23912ef0d
Revises: f2eab71d5881
Create Date: 2026-11-16 13:19:01.712003

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2ca23912ef0d'
down_revision: Union[str, Sequence[str], None] = 'f2eab71d5881'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("areas", sa.Column("master_profile", sa.String(32), nullable=True, server_default="auto"))
    op.add_column("areas", sa.Column("group_by_attribute", sa.String(32), nullable=True, server_default="auto"))
    op.add_column("areas", sa.Column("show_dimensions", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("areas", sa.Column("show_cnc_program", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("areas", sa.Column("show_edge_specs", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("areas", sa.Column("has_pusk_pieces", sa.Boolean(), nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("areas", "has_pusk_pieces")
    op.drop_column("areas", "show_edge_specs")
    op.drop_column("areas", "show_cnc_program")
    op.drop_column("areas", "show_dimensions")
    op.drop_column("areas", "group_by_attribute")
    op.drop_column("areas", "master_profile")
