"""гибкая ролевая модель ролей и прав (8.3 раздел бэклога доработок)

Заводит `permissions` (фиксированный каталог, 19 прав — 1:1 с текущими
require_roles(...) по API плюс два права, которые раньше проверялись только
на фронтенде: reports.view, sales_calculator.view), `roles` (создаваемые,
сидятся 7 системных ролей под старые значения UserRole), M2M
`role_permissions`/`user_roles`. `users.role` (enum) переносится в
`user_roles` 1:1 по совпадению кода, `role='admin'` становится
`is_superuser=true`, после чего колонка и enum-тип удаляются.

Revision ID: 2efa87769c18
Revises: 48d83d644681
Create Date: 2026-08-11 09:48:18.109340

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2efa87769c18'
down_revision: Union[str, Sequence[str], None] = '48d83d644681'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


PERMISSIONS = [
    (1, "units.receive", "Приёмка партии", "Склад"),
    (2, "units.writeoff", "Списание единицы", "Склад"),
    (3, "units.place", "Размещение в ячейку", "Склад"),
    (4, "units.split", "Разделение рулона (резка по ширине)", "Склад"),
    (5, "units.issue", "Выдача участку", "Склад"),
    (6, "units.cut", "Раскрой по длине", "Склад"),
    (7, "units.return", "Возврат остатка", "Склад"),
    (8, "inventory.manage", "Инвентаризация", "Склад"),
    (9, "storage.manage", "Стеллажи и макрозонирование", "Склад"),
    (10, "orders.plan", "Строки потребности заказа", "Планирование"),
    (11, "calc_settings.manage", "Настройки расчётов", "Планирование"),
    (12, "reports.view", "Отчёты", "Планирование"),
    (13, "orders.manage", "Создание заказов", "Заказы"),
    (14, "orders.close", "Закрытие заказа", "Заказы"),
    (15, "purchasing.manage", "Заявки поставщику", "Закупки"),
    (16, "sales_calculator.view", "Калькулятор заказа", "Закупки"),
    (17, "materials.manage", "Справочники и номенклатура", "Администрирование"),
    (18, "labels.manage", "Макет этикетки", "Администрирование"),
    (19, "users.manage", "Пользователи, роли и права", "Администрирование"),
]

ROLES = [
    (1, "operator_sklada", "Оператор склада"),
    (2, "kladovshchik", "Кладовщик"),
    (3, "nachalnik_uchastka", "Начальник участка"),
    (4, "nachalnik_tsekha", "Начальник цеха"),
    (5, "logist", "Логист/руководитель"),
    (6, "snabzhenets", "Снабженец/закупщик"),
    (7, "prodazhnik", "Продажник"),
]

# role_id -> [permission_id, ...] — 1:1 перенос текущих require_roles(...)
ROLE_PERMISSIONS = {
    1: [1, 2, 3, 4, 5, 6, 7],  # operator_sklada
    2: [2, 3, 7, 8, 14],  # kladovshchik
    3: [6, 7],  # nachalnik_uchastka
    4: [10, 12],  # nachalnik_tsekha
    5: [8, 9, 11, 12, 13, 14, 17, 18, 19],  # logist
    6: [15],  # snabzhenets
    7: [16],  # prodazhnik
}


def upgrade() -> None:
    """Upgrade schema."""
    permissions_table = op.create_table(
        "permissions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("section", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    roles_table = op.create_table(
        "roles",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
        sa.UniqueConstraint("name"),
    )
    role_permissions_table = op.create_table(
        "role_permissions",
        sa.Column("role_id", sa.Integer(), nullable=False),
        sa.Column("permission_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["permission_id"], ["permissions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["role_id"], ["roles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("role_id", "permission_id"),
    )
    op.create_table(
        "user_roles",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["role_id"], ["roles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "role_id"),
    )
    op.add_column("users", sa.Column("is_superuser", sa.Boolean(), server_default=sa.false(), nullable=False))

    op.bulk_insert(
        permissions_table,
        [{"id": id_, "code": code, "name": name, "section": section} for id_, code, name, section in PERMISSIONS],
    )
    op.bulk_insert(
        roles_table,
        [{"id": id_, "code": code, "name": name, "is_active": True} for id_, code, name in ROLES],
    )
    op.bulk_insert(
        role_permissions_table,
        [
            {"role_id": role_id, "permission_id": permission_id}
            for role_id, permission_ids in ROLE_PERMISSIONS.items()
            for permission_id in permission_ids
        ],
    )
    # Сброс сиквенсов — bulk_insert выше вставлял явные id, следующий
    # обычный insert (создание роли/права через API) должен продолжить с
    # максимума, а не начать заново с 1.
    op.execute("SELECT setval('permissions_id_seq', (SELECT MAX(id) FROM permissions))")
    op.execute("SELECT setval('roles_id_seq', (SELECT MAX(id) FROM roles))")

    # Перенос users.role -> user_roles/is_superuser (1:1, без потери
    # поведения) — проект ещё не в проде (раздел 7 бэклога), реальных
    # пользователей единицы, миграция данных простая. Значения enum-колонки
    # хранятся как ИМЕНА членов Python-enum (SQLAlchemy Enum по умолчанию), то
    # есть в верхнем регистре ("OPERATOR_SKLADA"), а не как .value ("operator_
    # sklada") — отсюда lower() при сопоставлении с Role.code.
    connection = op.get_bind()
    connection.execute(sa.text("UPDATE users SET is_superuser = true WHERE role = 'ADMIN'"))
    connection.execute(
        sa.text(
            """
            INSERT INTO user_roles (user_id, role_id)
            SELECT users.id, roles.id
            FROM users
            JOIN roles ON roles.code = lower(users.role::text)
            WHERE users.role IS NOT NULL AND users.role != 'ADMIN'
            """
        )
    )

    op.drop_column("users", "role")
    op.execute("DROP TYPE user_role")


def downgrade() -> None:
    """Downgrade schema."""
    # Enum-лейблы — верхний регистр (имена членов Python-enum), см. комментарий
    # в upgrade() про lower() при переносе.
    op.execute(
        "CREATE TYPE user_role AS ENUM ('NACHALNIK_TSEKHA', 'NACHALNIK_UCHASTKA', 'OPERATOR_SKLADA', "
        "'KLADOVSHCHIK', 'SNABZHENETS', 'LOGIST', 'ADMIN', 'PRODAZHNIK')"
    )
    op.add_column("users", sa.Column("role", sa.Enum(name="user_role"), nullable=True))

    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
            UPDATE users
            SET role = upper(roles.code)::user_role
            FROM user_roles
            JOIN roles ON roles.id = user_roles.role_id
            WHERE user_roles.user_id = users.id AND roles.code IS NOT NULL
            """
        )
    )
    connection.execute(sa.text("UPDATE users SET role = 'ADMIN' WHERE is_superuser = true"))
    connection.execute(sa.text("UPDATE users SET role = 'OPERATOR_SKLADA' WHERE role IS NULL"))
    op.alter_column("users", "role", nullable=False)

    op.drop_column("users", "is_superuser")
    op.drop_table("user_roles")
    op.drop_table("role_permissions")
    op.drop_table("roles")
    op.drop_table("permissions")
