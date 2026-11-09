"""Индексы производительности производства и склада.

Revision ID: b5e7d1a3c9f2
Revises: a4c8e2f6b0d1
Create Date: 2026-11-09
"""

from alembic import op


revision = "b5e7d1a3c9f2"
down_revision = "a4c8e2f6b0d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. production_tasks
    op.create_index(
        "ix_production_tasks_is_active",
        "production_tasks",
        ["is_active"],
    )
    op.create_index(
        "ix_production_tasks_area_is_active",
        "production_tasks",
        ["area", "is_active"],
    )
    op.create_index(
        "ix_production_tasks_created_at",
        "production_tasks",
        ["created_at"],
    )

    # 2. production_task_lines
    op.create_index(
        "ix_production_task_lines_task_id",
        "production_task_lines",
        ["task_id"],
    )
    op.create_index(
        "ix_production_task_lines_task_closed",
        "production_task_lines",
        ["task_id", "is_closed"],
    )

    # 3. production_task_line_reports
    op.create_index(
        "ix_production_task_line_reports_task_line_id",
        "production_task_line_reports",
        ["task_line_id"],
    )
    op.create_index(
        "ix_production_task_line_reports_reported_at",
        "production_task_line_reports",
        ["reported_at"],
    )
    op.create_index(
        "ix_production_task_line_reports_line_counts",
        "production_task_line_reports",
        ["task_line_id", "counts_toward_line"],
    )

    # 4. production_task_line_assignments
    op.create_index(
        "ix_production_task_line_assignments_task_line_id",
        "production_task_line_assignments",
        ["task_line_id"],
    )
    op.create_index(
        "ix_production_task_line_assignments_date",
        "production_task_line_assignments",
        ["date"],
    )

    # 5. material_units
    op.create_index(
        "ix_material_units_status",
        "material_units",
        ["status"],
    )
    op.create_index(
        "ix_material_units_area_status",
        "material_units",
        ["area", "status"],
    )
    op.create_index(
        "ix_material_units_task_line_id",
        "material_units",
        ["production_task_line_id"],
    )

    # 6. material_events
    op.create_index(
        "ix_material_events_unit_type_ts",
        "material_events",
        ["unit_id", "event_type", "timestamp"],
    )


def downgrade() -> None:
    op.drop_index("ix_material_events_unit_type_ts", table_name="material_events")
    op.drop_index("ix_material_units_task_line_id", table_name="material_units")
    op.drop_index("ix_material_units_area_status", table_name="material_units")
    op.drop_index("ix_material_units_status", table_name="material_units")
    op.drop_index("ix_production_task_line_assignments_date", table_name="production_task_line_assignments")
    op.drop_index("ix_production_task_line_assignments_task_line_id", table_name="production_task_line_assignments")
    op.drop_index("ix_production_task_line_reports_line_counts", table_name="production_task_line_reports")
    op.drop_index("ix_production_task_line_reports_reported_at", table_name="production_task_line_reports")
    op.drop_index("ix_production_task_line_reports_task_line_id", table_name="production_task_line_reports")
    op.drop_index("ix_production_task_lines_task_closed", table_name="production_task_lines")
    op.drop_index("ix_production_task_lines_task_id", table_name="production_task_lines")
    op.drop_index("ix_production_tasks_created_at", table_name="production_tasks")
    op.drop_index("ix_production_tasks_area_is_active", table_name="production_tasks")
    op.drop_index("ix_production_tasks_is_active", table_name="production_tasks")
