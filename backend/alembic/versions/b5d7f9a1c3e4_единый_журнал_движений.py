"""Единый журнал движений партий — представление lot_movements

Revision ID: b5d7f9a1c3e4
Revises: a4c6e8f0b2d3
Create Date: 2026-10-08 15:00:00.000000

Одна выборка поверх четырёх журналов (таблицы остаются свои): плёнка
(material_events), п/ф (part_unit_events), материалы (material_moves),
готовые изделия (fg_moves). Читают экран «Журнал движений» и отчёты.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'b5d7f9a1c3e4'
down_revision: Union[str, Sequence[str], None] = 'a4c6e8f0b2d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

VIEW = """
CREATE VIEW lot_movements AS
SELECT 'film'::text AS kind, e.event_id AS src_id, e.unit_id AS lot_id, s.item_id AS item_id,
       e.timestamp AS occurred_at, e.event_type::text AS op,
       e.quantity_delta_m AS qty, 'м'::text AS unit,
       round(e.quantity_delta_m * e.width_mm / 1000, 3) AS qty_m2,
       e.amount_rub AS amount_rub, e.area AS area, e.from_cell AS cell_from, e.to_cell AS cell_to,
       e.user_id AS user_id, e.production_task_line_id AS task_line_id, e.write_off_reason AS reason,
       e.write_off_note AS note, e.to_length AS to_length, NULL::integer AS stage_from, NULL::integer AS stage_to
  FROM material_events e JOIN material_skus s ON s.id = e.material_sku_id
UNION ALL
SELECT 'pf', pe.id, pe.part_unit_id, p.item_id,
       pe.occurred_at, pe.event_type::text,
       pe.quantity_delta, 'шт', NULL,
       pe.amount_rub, pe.area, pe.from_cell, pe.to_cell,
       pe.user_id, pe.production_task_line_id, pe.write_off_reason,
       coalesce(pe.write_off_note, pe.note), NULL::numeric, pe.from_stage_id, pe.to_stage_id
  FROM part_unit_events pe JOIN part_units pu ON pu.id = pe.part_unit_id JOIN parts p ON p.id = pu.part_id
UNION ALL
SELECT 'material', m.id, NULL, m.item_id,
       m.occurred_at, m.kind,
       m.qty, coalesce(i.unit, k.unit), NULL,
       m.amount_rub, NULL, NULL, NULL,
       m.user_id, m.task_line_id, NULL,
       coalesce(m.note, m.doc), NULL::numeric, NULL::integer, NULL::integer
  FROM material_moves m JOIN items i ON i.id = m.item_id JOIN item_kinds k ON k.id = i.kind_id
UNION ALL
SELECT 'fg', f.id, NULL, f.item_id,
       f.occurred_at, f.kind,
       f.qty, 'шт', NULL,
       f.amount_rub, NULL, NULL, NULL,
       f.user_id, NULL, NULL,
       concat_ws(' · ', 'счёт ' || f.invoice_no, f.note), NULL::numeric, NULL::integer, NULL::integer
  FROM fg_moves f
"""


def upgrade() -> None:
    op.execute(VIEW)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS lot_movements")
