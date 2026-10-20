"""место по умолчанию склада (19.10)

Revision ID: c2e4a6b8d0f1
Revises: b9d1f3a5c7e2
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c2e4a6b8d0f1"
down_revision: Union[str, Sequence[str], None] = "b9d1f3a5c7e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("warehouses", sa.Column("default_cell", sa.String(32), nullable=True))
    # склад, где стоит «Перемотка», — его место по умолчанию «Перемотка-01»
    op.execute(
        "UPDATE warehouses SET default_cell = 'Перемотка-01' "
        "WHERE id = (SELECT warehouse_id FROM racks WHERE code = 'Перемотка' LIMIT 1)"
    )


def downgrade() -> None:
    op.drop_column("warehouses", "default_cell")
