"""Событие Завершение для партий п ф

Revision ID: bc662948f97c
Revises: 69ba394a56cf
Create Date: 2026-09-07 12:13:02.406374

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'bc662948f97c'
down_revision: Union[str, Sequence[str], None] = '69ba394a56cf'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Раздел про связь этапов с участками — партия, дошедшая до последнего
    # этапа своего маршрута (или "осиротевшая" при перенастройке справочника),
    # больше не роняет отчёт участка ошибкой "нет следующего этапа": вместо
    # этого фиксируется отдельным событием, само не используется в этой
    # миграции — ADD VALUE не может идти в одной транзакции с использованием.
    op.execute("ALTER TYPE part_event_type ADD VALUE IF NOT EXISTS 'ZAVERSHENIE'")


def downgrade() -> None:
    # Postgres не умеет удалять одно значение enum — откат enum-а не
    # предусмотрен (тот же осознанный компромисс, что и у остальных
    # ADD VALUE-миграций в этом проекте).
    pass
