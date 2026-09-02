"""модели погонажа флаг is_trim

Revision ID: fc3a35f5e4dd
Revises: 5e87eb25bd54
Create Date: 2026-09-02 17:18:08.628401

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fc3a35f5e4dd'
down_revision: Union[str, Sequence[str], None] = '5e87eb25bd54'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TRIM_NAME_PREFIXES = ["Добор%", "Коробка%", "Наличник%", "Планка%", "Плинтус%"]


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "product_models",
        sa.Column("is_trim", sa.Boolean(), nullable=False, server_default="false"),
    )
    # Backfill по названию, не по id (портируемо между окружениями) — уже
    # существующие погонажные "модели" (короб/наличник/добор/планка/
    # плинтус) заведены как обычные ProductModel с одной BOM-строкой, но
    # это не дверное полотно, а комплект, добавляемый к дверной строке
    # заказа (раздел про калькулятор заказа). Ни одна реальная дверь не
    # начинается с этих слов — префиксы безопасны.
    conn = op.get_bind()
    for prefix in TRIM_NAME_PREFIXES:
        conn.execute(
            sa.text("UPDATE product_models SET is_trim = true WHERE name LIKE :prefix"),
            {"prefix": prefix},
        )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("product_models", "is_trim")
