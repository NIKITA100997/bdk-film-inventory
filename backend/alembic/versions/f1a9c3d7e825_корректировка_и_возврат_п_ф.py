"""Корректировка (плёнка+п/ф) и возврат партии п/ф — ревизия путей

Revision ID: f1a9c3d7e825
Revises: d3f6a8e2c951
Create Date: 2026-09-11 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f1a9c3d7e825'
down_revision: Union[str, Sequence[str], None] = 'd3f6a8e2c951'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


permissions_table = sa.table(
    "permissions",
    sa.column("code", sa.String),
    sa.column("name", sa.String),
    sa.column("section", sa.String),
)

# Раздел про ревизию путей плёнки/п/ф — формальная "Корректировка" вместо
# правки истории напрямую в БД (см. услуги этой сессии по штрипсам
# 2115/2324/«Багет Б-2/М»). Право узкое, никому не назначаем автоматически
# в этой миграции — суперпользователь и так проходит любую проверку прав в
# обход role_permissions; остальным ролям выдаётся вручную через «Роли»
# (RoleAdmin.tsx), когда решат, кому это доверить.
NEW_PERMISSIONS = [
    {"code": "units.correct", "name": "Корректировка остатка рулона/штрипса", "section": "Склад"},
    {"code": "part_units.correct", "name": "Корректировка/возврат партии п/ф", "section": "Производство"},
]


def upgrade() -> None:
    # ADD VALUE не может идти в одной транзакции со своим использованием —
    # тот же приём, что во всех предыдущих ADD VALUE-миграциях проекта.
    op.execute("ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'KORREKTIROVKA'")
    op.execute("ALTER TYPE part_event_type ADD VALUE IF NOT EXISTS 'VOZVRAT'")
    op.execute("ALTER TYPE part_event_type ADD VALUE IF NOT EXISTS 'KORREKTIROVKA'")
    op.bulk_insert(permissions_table, NEW_PERMISSIONS)


def downgrade() -> None:
    op.execute("DELETE FROM permissions WHERE code IN ('units.correct', 'part_units.correct')")
    # Postgres не умеет удалять одно значение enum — откат enum-а не
    # предусмотрен (тот же осознанный компромисс, что и у остальных
    # ADD VALUE-миграций в этом проекте).
