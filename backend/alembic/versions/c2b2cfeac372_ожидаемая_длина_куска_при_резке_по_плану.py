"""Ожидаемая длина куска при резке по плану

Revision ID: c2b2cfeac372
Revises: c4d8e1f6a3b7
Create Date: 2026-08-18 10:02:07.235051

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c2b2cfeac372'
down_revision: Union[str, Sequence[str], None] = 'c4d8e1f6a3b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Раздел про план резки на несколько ширин за проход — теоретическая
    длина куска на момент резки, чтобы позже сверить с реально введённой
    контрольной длиной (отчёт "Отклонения при резке"). Nullable-добавление,
    без преобразования существующих строк."""
    op.add_column("material_events", sa.Column("expected_length_m", sa.Numeric(12, 3), nullable=True))


def downgrade() -> None:
    op.drop_column("material_events", "expected_length_m")
