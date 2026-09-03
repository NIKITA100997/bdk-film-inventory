"""Физический учёт деталей (п/ф → заготовка) — пилот на окутке царговых

Revision ID: 119fbe243271
Revises: a1c7d3e9f204
Create Date: 2026-09-03 13:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '119fbe243271'
down_revision: Union[str, Sequence[str], None] = 'a1c7d3e9f204'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


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
write_off_reasons_table = sa.table(
    "write_off_reasons",
    sa.column("code", sa.String),
    sa.column("name", sa.String),
    sa.column("is_active", sa.Boolean),
    sa.column("is_system", sa.Boolean),
    sa.column("category", sa.String),
)

# role_id 3/4/5 = nachalnik_uchastka/nachalnik_tsekha/logist (см. ROLES в
# 2efa87769c18_гибкая_ролевая_модель_ролей_и_прав.py).
NEW_PERMISSIONS = [
    {"code": "part_units.manage", "name": "Учёт производства, выдача и списание п/ф", "section": "Производство"},
    {"code": "part_units.view", "name": "Просмотр остатков п/ф", "section": "Производство"},
]

NEW_REASONS = [
    {"code": "skol", "name": "Скол", "category": "parts"},
    {"code": "treshchina", "name": "Трещина", "category": "parts"},
    {"code": "brak_materiala", "name": "Брак материала", "category": "parts"},
]


def upgrade() -> None:
    op.create_table(
        "part_stages",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("part_id", sa.Integer(), nullable=False),
        sa.Column("sequence_order", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.ForeignKeyConstraint(["part_id"], ["parts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("part_id", "sequence_order", name="uq_part_stage_order"),
    )
    op.create_index(op.f("ix_part_stages_part_id"), "part_stages", ["part_id"])

    op.create_table(
        "part_units",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("part_id", sa.Integer(), nullable=False),
        sa.Column("quantity_pieces", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("stage_id", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("NA_KHRANENII", "VYDAN_UCHASTKU", "SPISAN", name="part_unit_status"),
            nullable=False,
        ),
        sa.Column("area", sa.String(), nullable=True),
        sa.Column("location_code", sa.String(length=64), nullable=True),
        sa.Column("production_task_line_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["parent_id"], ["part_units.id"]),
        sa.ForeignKeyConstraint(["part_id"], ["parts.id"]),
        sa.ForeignKeyConstraint(["stage_id"], ["part_stages.id"]),
        sa.ForeignKeyConstraint(["area"], ["areas.code"]),
        sa.ForeignKeyConstraint(["production_task_line_id"], ["production_task_lines.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_part_units_part_id"), "part_units", ["part_id"])
    op.create_index(op.f("ix_part_units_production_task_line_id"), "part_units", ["production_task_line_id"])

    op.create_table(
        "part_unit_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("part_unit_id", sa.Integer(), nullable=False),
        sa.Column(
            "event_type",
            sa.Enum(
                "PROIZVODSTVO", "VYDACHA_UCHASTKU", "PEREKHOD_ETAPA", "SPISANIE", name="part_event_type"
            ),
            nullable=False,
        ),
        sa.Column("quantity_delta", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("from_stage_id", sa.Integer(), nullable=True),
        sa.Column("to_stage_id", sa.Integer(), nullable=True),
        sa.Column("area", sa.String(), nullable=True),
        sa.Column("production_task_line_id", sa.Integer(), nullable=True),
        sa.Column("write_off_reason", sa.String(length=64), nullable=True),
        sa.Column("write_off_note", sa.String(length=255), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(["part_unit_id"], ["part_units.id"]),
        sa.ForeignKeyConstraint(["from_stage_id"], ["part_stages.id"]),
        sa.ForeignKeyConstraint(["to_stage_id"], ["part_stages.id"]),
        sa.ForeignKeyConstraint(["area"], ["areas.code"]),
        sa.ForeignKeyConstraint(["production_task_line_id"], ["production_task_lines.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["write_off_reason"], ["write_off_reasons.code"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_part_unit_events_part_unit_id"), "part_unit_events", ["part_unit_id"])
    op.create_index(op.f("ix_part_unit_events_occurred_at"), "part_unit_events", ["occurred_at"])

    op.add_column("production_task_line_reports", sa.Column("part_unit_id", sa.Integer(), nullable=True))
    op.create_index(
        op.f("ix_production_task_line_reports_part_unit_id"),
        "production_task_line_reports", ["part_unit_id"],
    )
    op.create_foreign_key(
        None, "production_task_line_reports", "part_units", ["part_unit_id"], ["id"], ondelete="SET NULL",
    )

    op.bulk_insert(permissions_table, NEW_PERMISSIONS)
    conn = op.get_bind()
    manage_id = conn.execute(
        sa.text("SELECT id FROM permissions WHERE code = 'part_units.manage'")
    ).scalar_one()
    view_id = conn.execute(
        sa.text("SELECT id FROM permissions WHERE code = 'part_units.view'")
    ).scalar_one()
    op.bulk_insert(role_permissions_table, [{"role_id": 4, "permission_id": manage_id}])
    op.bulk_insert(
        role_permissions_table,
        [{"role_id": role_id, "permission_id": view_id} for role_id in (3, 4, 5)],
    )

    op.bulk_insert(
        write_off_reasons_table,
        [{"is_active": True, "is_system": False, **r} for r in NEW_REASONS],
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM write_off_reasons WHERE code IN ('skol', 'treshchina', 'brak_materiala')"
    )
    op.execute(
        "DELETE FROM role_permissions WHERE permission_id IN "
        "(SELECT id FROM permissions WHERE code IN ('part_units.manage', 'part_units.view'))"
    )
    op.execute("DELETE FROM permissions WHERE code IN ('part_units.manage', 'part_units.view')")

    op.drop_constraint(None, "production_task_line_reports", type_="foreignkey")
    op.drop_index(
        op.f("ix_production_task_line_reports_part_unit_id"),
        table_name="production_task_line_reports",
    )
    op.drop_column("production_task_line_reports", "part_unit_id")

    op.drop_index(op.f("ix_part_unit_events_occurred_at"), table_name="part_unit_events")
    op.drop_index(op.f("ix_part_unit_events_part_unit_id"), table_name="part_unit_events")
    op.drop_table("part_unit_events")

    op.drop_index(op.f("ix_part_units_production_task_line_id"), table_name="part_units")
    op.drop_index(op.f("ix_part_units_part_id"), table_name="part_units")
    op.drop_table("part_units")
    op.execute("DROP TYPE part_unit_status")
    op.execute("DROP TYPE part_event_type")

    op.drop_index(op.f("ix_part_stages_part_id"), table_name="part_stages")
    op.drop_table("part_stages")
