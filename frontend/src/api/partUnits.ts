import { apiClient } from "./client";

// Физическая партия деталей (лот в штуках, зеркалит MaterialUnit) —
// раздел про физический учёт деталей (пилот: окутка царговых).
export type PartUnitStatus = "На_хранении" | "Выдан_участку" | "Списан";

export interface PartUnit {
  id: number;
  parent_id: number | null;
  part_id: number;
  part_name: string;
  quantity_pieces: number;
  stage_id: number;
  stage_name: string;
  status: PartUnitStatus;
  area: string | null;
  location_code: string | null;
  production_task_line_id: number | null;
  note: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
}

export interface PartUnitCreate {
  part_id: number;
  quantity_pieces: number;
  production_task_line_id?: number | null;
  issue_to_area?: string | null;
  note?: string | null;
}

export interface PartUnitEvent {
  id: number;
  event_type: string;
  quantity_delta: number;
  from_stage_id: number | null;
  to_stage_id: number | null;
  area: string | null;
  write_off_reason: string | null;
  write_off_note: string | null;
  user_id: number;
  occurred_at: string;
  note: string | null;
}

export interface PartUnitListFilters {
  part_id?: number;
  area?: string;
  status_?: PartUnitStatus;
  stage_id?: number;
  production_task_line_id?: number;
}

export const listPartUnits = async (filters: PartUnitListFilters = {}): Promise<PartUnit[]> =>
  (await apiClient.get<PartUnit[]>("/part-units", { params: filters })).data;

export const createPartUnit = async (payload: PartUnitCreate): Promise<PartUnit> =>
  (await apiClient.post<PartUnit>("/part-units", payload)).data;

export const issuePartUnit = async (id: number, area: string): Promise<PartUnit> =>
  (await apiClient.post<PartUnit>(`/part-units/${id}/issue`, { area })).data;

export const writeOffPartUnit = async (
  id: number,
  payload: { quantity_pieces: number; reason: string; note?: string },
): Promise<PartUnit> => (await apiClient.post<PartUnit>(`/part-units/${id}/write-off`, payload)).data;

export const listPartUnitEvents = async (id: number): Promise<PartUnitEvent[]> =>
  (await apiClient.get<PartUnitEvent[]>(`/part-units/${id}/events`)).data;
