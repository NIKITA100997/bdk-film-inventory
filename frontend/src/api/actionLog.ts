import { apiClient } from "./client";

// Раздел про журнал действий (ревизия путей плёнки/п/ф) — плоская
// хронология по ВСЕМ рулонам/партиям сразу, полнее /movement (все поля
// события). Дополняет специализированные экраны (история резок,
// перемещения, инвентаризация), не заменяет их.

export interface ActionLogMaterialLine {
  event_id: number;
  unit_id: number;
  timestamp: string;
  user_id: number;
  user_name: string;
  event_type: string;
  area: string | null;
  material: string;
  color: string;
  thickness: number;
  width_mm: number;
  quantity_delta_m: number;
  from_length: number | null;
  to_length: number | null;
  from_cell: string | null;
  to_cell: string | null;
  write_off_reason: string | null;
  write_off_reason_name: string | null;
  write_off_note: string | null;
  expected_length_m: number | null;
  cutting_operation_id: number | null;
  inventory_session_id: number | null;
  production_task_line_id: number | null;
  part_name: string | null;
  task_name: string | null;
}

export interface ActionLogPartUnitLine {
  id: number;
  part_unit_id: number;
  occurred_at: string;
  user_id: number;
  user_name: string;
  event_type: string;
  area: string | null;
  part_name: string;
  stage_name: string | null;
  quantity_delta: number;
  from_stage_id: number | null;
  to_stage_id: number | null;
  from_cell: string | null;
  to_cell: string | null;
  write_off_reason: string | null;
  write_off_reason_name: string | null;
  write_off_note: string | null;
  production_task_line_id: number | null;
  task_name: string | null;
  note: string | null;
}

export interface ActionLogFilters {
  date_from?: string;
  date_to?: string;
  event_type?: string[];
  area?: string[];
  user_id?: number;
  unit_id?: number;
  production_task_line_id?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

export const getActionLogMaterial = async (filters: ActionLogFilters = {}): Promise<ActionLogMaterialLine[]> =>
  (await apiClient.get<ActionLogMaterialLine[]>("/reports/action-log/material", { params: filters })).data;

export interface ActionLogPartUnitFilters extends Omit<ActionLogFilters, "unit_id"> {
  part_id?: number;
  part_unit_id?: number;
}

export const getActionLogPartUnits = async (filters: ActionLogPartUnitFilters = {}): Promise<ActionLogPartUnitLine[]> =>
  (await apiClient.get<ActionLogPartUnitLine[]>("/reports/action-log/part-units", { params: filters })).data;

// Раздел про формальную «Корректировку» (не правка истории напрямую в
// БД) — общий вход для журнала: material — length_m рулона/штрипса,
// part-unit — quantity_pieces партии.
export const adjustMaterialUnit = async (
  unitId: number,
  payload: { actual_length_m: number; reason: string; note?: string },
): Promise<void> => {
  await apiClient.post(`/units/${unitId}/adjust`, payload);
};

export const adjustPartUnitEntry = async (
  unitId: number,
  payload: { actual_quantity_pieces: number; reason: string; note?: string },
): Promise<void> => {
  await apiClient.post(`/part-units/${unitId}/adjust`, payload);
};
