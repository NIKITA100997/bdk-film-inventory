"""Раздельные макеты стеллажа и полки

Revision ID: 3f8b6e1a9c2d
Revises: 7d4a1c9e2f6b
Create Date: 2026-08-17 00:00:00.000001

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision: str = '3f8b6e1a9c2d'
down_revision: Union[str, Sequence[str], None] = '7d4a1c9e2f6b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Прежний единственный "rack"-макет был про места хранения (полка/
    # ячейка) — переименовываем его в "shelf", освобождая "rack" под новую
    # отдельную бирку на весь стеллаж целиком.
    op.execute("UPDATE label_templates SET kind = 'shelf' WHERE kind = 'rack'")

    # Та же последовательность-десинхронизация, что уже чинили в
    # 7d4a1c9e2f6b — синхронизируем перед новой вставкой.
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
                    {"key": "rack_code", "size": "lg", "bold": True},
                    {"key": "warehouse_name", "size": "sm", "bold": False},
                    {"key": "rack_type", "size": "sm", "bold": False},
                    {"key": "shelf_count", "size": "sm", "bold": False},
                ],
            }
        ],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DELETE FROM label_templates WHERE kind = 'rack'")
    op.execute("UPDATE label_templates SET kind = 'rack' WHERE kind = 'shelf'")
