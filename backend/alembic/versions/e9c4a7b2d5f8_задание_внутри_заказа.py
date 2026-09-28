"""Каждое задание цеха — внутри заказа на производство: существующим
заданиям без заказа — по заказу-обёртке (без строк позиций; активное
задание — заказ запущен, архивное — закрыт).

Revision ID: e9c4a7b2d5f8
Revises: d8b3f6a1c4e7
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e9c4a7b2d5f8"
down_revision: Union[str, Sequence[str], None] = "d8b3f6a1c4e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            """
            SELECT t.id, COALESCE(NULLIF(TRIM(t.name), ''), pm.name, 'Задание №' || t.id) AS name,
                   t.is_active, t.created_by, t.created_at
            FROM production_tasks t
            LEFT JOIN product_models pm ON pm.id = t.product_model_id
            WHERE t.production_order_id IS NULL
            ORDER BY t.id
            """
        )
    ).all()
    for task_id, name, is_active, created_by, created_at in rows:
        order_id = conn.execute(
            sa.text(
                """
                INSERT INTO production_orders (name, status, created_by, created_at, released_at)
                VALUES (:name, :status, :created_by, :created_at, :created_at)
                RETURNING id
                """
            ),
            {
                "name": name[:255],
                "status": "released" if is_active else "closed",
                "created_by": created_by,
                "created_at": created_at,
            },
        ).scalar_one()
        conn.execute(
            sa.text("UPDATE production_tasks SET production_order_id = :o WHERE id = :t"), {"o": order_id, "t": task_id}
        )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE production_tasks SET production_order_id = NULL
            WHERE production_order_id IN (
                SELECT o.id FROM production_orders o
                WHERE NOT EXISTS (SELECT 1 FROM production_order_lines l WHERE l.order_id = o.id)
            )
            """
        )
    )
    conn.execute(
        sa.text(
            """
            DELETE FROM production_orders o
            WHERE NOT EXISTS (SELECT 1 FROM production_order_lines l WHERE l.order_id = o.id)
              AND NOT EXISTS (SELECT 1 FROM production_tasks t WHERE t.production_order_id = o.id)
            """
        )
    )
