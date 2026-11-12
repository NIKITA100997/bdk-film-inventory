"""дополнительные_индексы_хранения_и_учета

Revision ID: f2eab71d5881
Revises: b5e7d1a3c9f2
Create Date: 2026-11-12 08:03:48.023321

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f2eab71d5881'
down_revision: Union[str, Sequence[str], None] = 'b5e7d1a3c9f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. material_events
    op.create_index(
        "ix_material_events_inventory_session_id",
        "material_events",
        ["inventory_session_id"],
    )
    op.create_index(
        "ix_material_events_event_type_ts",
        "material_events",
        ["event_type", "timestamp"],
    )
    op.create_index(
        "ix_material_events_area_ts",
        "material_events",
        ["area", "timestamp"],
    )
    op.create_index(
        "ix_material_events_prod_task_line",
        "material_events",
        ["production_task_line_id"],
    )

    # 2. part_units
    op.create_index(
        "ix_part_units_area_status",
        "part_units",
        ["area", "status"],
    )
    op.create_index(
        "ix_part_units_part_status",
        "part_units",
        ["part_id", "status"],
    )
    op.create_index(
        "ix_part_units_area_stage_status",
        "part_units",
        ["area", "stage_id", "status"],
    )
    op.create_index(
        "ix_part_units_manufactured_at",
        "part_units",
        ["manufactured_at"],
    )

    # 3. part_unit_events
    op.create_index(
        "ix_part_unit_events_unit_type",
        "part_unit_events",
        ["part_unit_id", "event_type"],
    )

    # 4. part_count_lines
    op.create_index(
        "ix_part_count_lines_part_unit",
        "part_count_lines",
        ["part_unit_id"],
    )
    op.create_index(
        "ix_part_count_lines_material_unit",
        "part_count_lines",
        ["material_unit_id"],
    )
    op.create_index(
        "ix_part_count_lines_item",
        "part_count_lines",
        ["item_id"],
    )

    # 5. part_count_sessions
    op.create_index(
        "ix_part_count_sessions_place_status",
        "part_count_sessions",
        ["place_type", "place_ref", "status"],
    )
    op.create_index(
        "ix_part_count_sessions_status_started",
        "part_count_sessions",
        ["status", "started_at"],
    )


def downgrade() -> None:
    # 5. part_count_sessions
    op.drop_index("ix_part_count_sessions_status_started", table_name="part_count_sessions")
    op.drop_index("ix_part_count_sessions_place_status", table_name="part_count_sessions")

    # 4. part_count_lines
    op.drop_index("ix_part_count_lines_item", table_name="part_count_lines")
    op.drop_index("ix_part_count_lines_material_unit", table_name="part_count_lines")
    op.drop_index("ix_part_count_lines_part_unit", table_name="part_count_lines")

    # 3. part_unit_events
    op.drop_index("ix_part_unit_events_unit_type", table_name="part_unit_events")

    # 2. part_units
    op.drop_index("ix_part_units_manufactured_at", table_name="part_units")
    op.drop_index("ix_part_units_area_stage_status", table_name="part_units")
    op.drop_index("ix_part_units_part_status", table_name="part_units")
    op.drop_index("ix_part_units_area_status", table_name="part_units")

    # 1. material_events
    op.drop_index("ix_material_events_prod_task_line", table_name="material_events")
    op.drop_index("ix_material_events_area_ts", table_name="material_events")
    op.drop_index("ix_material_events_event_type_ts", table_name="material_events")
    op.drop_index("ix_material_events_inventory_session_id", table_name="material_events")
