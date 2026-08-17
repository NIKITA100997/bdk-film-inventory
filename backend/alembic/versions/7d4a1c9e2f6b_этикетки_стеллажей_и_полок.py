"""Этикетки стеллажей и полок

Revision ID: 7d4a1c9e2f6b
Revises: 9c1f2e6a4d3b
Create Date: 2026-08-17 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision: str = '7d4a1c9e2f6b'
down_revision: Union[str, Sequence[str], None] = '9c1f2e6a4d3b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('label_templates', sa.Column('kind', sa.String(length=16), nullable=False, server_default='unit'))
    op.create_unique_constraint('label_templates_kind_key', 'label_templates', ['kind'])

    # Исходная строка (id=1) была заведена приложением с явным id, не через
    # последовательность — nextval() всё ещё вернёт 1 и столкнётся с ней.
    # Синхронизируем последовательность перед вставкой новой строки.
    op.execute("SELECT setval('label_templates_id_seq', COALESCE((SELECT MAX(id) FROM label_templates), 1))")

    label_templates = sa.table(
        'label_templates',
        sa.column('kind', sa.String),
        sa.column('width_mm', sa.Integer),
        sa.column('height_mm', sa.Integer),
        sa.column('fields', JSONB),
    )
    op.bulk_insert(
        label_templates,
        [
            {
                'kind': 'rack',
                'width_mm': 70,
                'height_mm': 40,
                'fields': [
                    {"key": "qr", "size": "md", "bold": False},
                    {"key": "location_code", "size": "lg", "bold": True},
                    {"key": "warehouse_name", "size": "sm", "bold": False},
                    {"key": "rack_type", "size": "sm", "bold": False},
                ],
            }
        ],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DELETE FROM label_templates WHERE kind = 'rack'")
    op.drop_constraint('label_templates_kind_key', 'label_templates', type_='unique')
    op.drop_column('label_templates', 'kind')
