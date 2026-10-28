"""модули главной у пользователя (28.10)

«Общее» — модульная главная: набор и порядок рабочих модулей сотрудника.
Пусто — стандартный набор по ролям.

Revision ID: e2b4d6f8a0c1
Revises: d7e9f1a3b5c7
Create Date: 2026-10-28 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

revision = "e2b4d6f8a0c1"
down_revision = "d7e9f1a3b5c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("home_modules", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "home_modules")
