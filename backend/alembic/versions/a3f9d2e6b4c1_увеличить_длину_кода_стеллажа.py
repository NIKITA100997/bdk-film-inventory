"""увеличить длину кода стеллажа

`racks.code` был String(16) — стеллажи в реальном использовании называют
описательными именами, а не короткими кодами (напр. "Стеллаж-размотка",
"Карусель_фабрика" — уже ровно на пределе в 16 символов), и создание/
переименование стеллажа с более длинным названием падало с 500
(StringDataRightTruncation), а не понятной ошибкой валидации — тот же
класс бага, что уже чинили для `areas.code` в f5a5e29c642f. Увеличиваем
до 128, тот же запас.

Revision ID: a3f9d2e6b4c1
Revises: c8a2f4e1b6d3
Create Date: 2026-08-31 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a3f9d2e6b4c1'
down_revision: Union[str, Sequence[str], None] = 'c8a2f4e1b6d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("racks", "code", type_=sa.String(length=128), existing_type=sa.String(length=16))


def downgrade() -> None:
    op.alter_column("racks", "code", type_=sa.String(length=16), existing_type=sa.String(length=128))
