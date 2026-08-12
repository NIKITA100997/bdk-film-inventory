"""Ручные задания, брак в производстве, привязка выдачи

Revision ID: 6ca5798b8b62
Revises: 352ee7df7bcc
Create Date: 2026-08-12 15:23:04.649252

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# write_off_reason — новый тип, но используется дважды в этой миграции
# (material_events.write_off_reason и
# production_task_line_reports.defect_reason) — общий объект с
# create_type=False и явным .create() один раз, иначе вторая ссылка
# попытается создать тип повторно (тот же приём, что AREA_ENUM в
# 74b754832f3f_мультисклад.py).
WRITE_OFF_REASON_ENUM = postgresql.ENUM(
    "SUPPLIER_DEFECT", "WAREHOUSE_DAMAGE", "WRONG_GRADE", "CUTTING_WASTE", "OTHER",
    name="write_off_reason", create_type=False,
)
# area уже существует (создан в исходной миграции) — переиспользуем с
# create_type=False, тот же приём.
AREA_ENUM = postgresql.ENUM(
    "OKUTKA_TSARGOVYKH", "SHCHITOVYE_DVERI", "TSELNOLISTOVYE_DVERI", name="area", create_type=False
)


permissions_table = sa.table(
    "permissions",
    sa.column("code", sa.String),
    sa.column("name", sa.String),
    sa.column("section", sa.String),
)
role_permissions_table = sa.table(
    "role_permissions",
    sa.column("role_id", sa.Integer),
    sa.column("permission_id", sa.Integer),
)

# role_id 3 = nachalnik_uchastka (см. ROLES в
# 2efa87769c18_гибкая_ролевая_модель_ролей_и_прав.py) — та же роль, что
# уже смотрит задания своего участка (production_tasks.view), теперь ещё
# и отчитывается по факту производства/браку.
NEW_PERMISSION_CODE = "production_tasks.report"

# revision identifiers, used by Alembic.
revision: str = '6ca5798b8b62'
down_revision: Union[str, Sequence[str], None] = '352ee7df7bcc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    WRITE_OFF_REASON_ENUM.create(op.get_bind(), checkfirst=True)

    op.create_table('production_task_line_reports',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('task_line_id', sa.Integer(), nullable=False),
    sa.Column('good_pieces', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('defect_pieces', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('defect_reason', WRITE_OFF_REASON_ENUM, nullable=True),
    sa.Column('note', sa.String(length=255), nullable=True),
    sa.Column('reported_by', sa.Integer(), nullable=False),
    sa.Column('reported_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['reported_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['task_line_id'], ['production_task_lines.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.add_column('material_events', sa.Column('production_task_line_id', sa.Integer(), nullable=True))
    op.add_column('material_events', sa.Column('write_off_reason', WRITE_OFF_REASON_ENUM, nullable=True))
    op.add_column('material_events', sa.Column('write_off_note', sa.String(length=255), nullable=True))
    op.create_foreign_key(None, 'material_events', 'production_task_lines', ['production_task_line_id'], ['id'])
    op.add_column('material_units', sa.Column('production_task_line_id', sa.Integer(), nullable=True))
    op.create_foreign_key(None, 'material_units', 'production_task_lines', ['production_task_line_id'], ['id'])
    op.add_column('production_tasks', sa.Column('name', sa.String(length=255), nullable=True))
    # area — NOT NULL, но существующие задания (все — BOM-based на момент
    # этой миграции, ручных ещё не существовало) получают его из своей
    # модели, прежде чем колонка станет обязательной.
    op.add_column('production_tasks', sa.Column('area', AREA_ENUM, nullable=True))
    op.execute(
        "UPDATE production_tasks SET area = product_models.area "
        "FROM product_models WHERE production_tasks.product_model_id = product_models.id"
    )
    op.alter_column('production_tasks', 'area', nullable=False)
    op.alter_column('production_tasks', 'product_model_id',
               existing_type=sa.INTEGER(),
               nullable=True)
    op.alter_column('production_tasks', 'quantity',
               existing_type=sa.INTEGER(),
               nullable=True)

    op.bulk_insert(
        permissions_table,
        [{"code": NEW_PERMISSION_CODE, "name": "Отчёт о браке по строке задания", "section": "Производство"}],
    )
    conn = op.get_bind()
    report_permission_id = conn.execute(
        sa.text("SELECT id FROM permissions WHERE code = :code"), {"code": NEW_PERMISSION_CODE}
    ).scalar_one()
    op.bulk_insert(role_permissions_table, [{"role_id": 3, "permission_id": report_permission_id}])


def downgrade() -> None:
    op.execute(
        "DELETE FROM role_permissions WHERE permission_id IN "
        "(SELECT id FROM permissions WHERE code = 'production_tasks.report')"
    )
    op.execute("DELETE FROM permissions WHERE code = 'production_tasks.report'")
    """Downgrade schema."""
    op.alter_column('production_tasks', 'quantity',
               existing_type=sa.INTEGER(),
               nullable=False)
    op.alter_column('production_tasks', 'product_model_id',
               existing_type=sa.INTEGER(),
               nullable=False)
    op.drop_column('production_tasks', 'area')
    op.drop_column('production_tasks', 'name')
    op.drop_constraint(None, 'material_units', type_='foreignkey')
    op.drop_column('material_units', 'production_task_line_id')
    op.drop_constraint(None, 'material_events', type_='foreignkey')
    op.drop_column('material_events', 'write_off_note')
    op.drop_column('material_events', 'write_off_reason')
    op.drop_column('material_events', 'production_task_line_id')
    op.drop_table('production_task_line_reports')
    WRITE_OFF_REASON_ENUM.drop(op.get_bind(), checkfirst=True)
