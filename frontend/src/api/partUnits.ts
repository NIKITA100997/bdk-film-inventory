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
  // Раздел про учёт п/ф по FIFO — дата изготовления (не дата записи в
  // систему), по ней партии теперь расходуются автоматически при
  // отчёте о готовых деталях (ISO-дата, "YYYY-MM-DD").
  manufactured_at: string;
  created_at: string;
  updated_at: string;
}

export interface PartUnitCreate {
  part_id: number;
  quantity_pieces: number;
  production_task_line_id?: number | null;
  // Раздел про связь этапов с участками — участок выдачи выводится из
  // выбранного этапа, здесь только факт "сразу выдать".
  issue?: boolean;
  note?: string | null;
  // Раздел про регистрацию задним числом — партия уже прошла часть
  // маршрута (например, уже склеена и отфрезерована), заводим её сразу
  // на этом этапе. Не задано — как раньше, первый этап детали.
  stage_id?: number | null;
  // Раздел про учёт п/ф по FIFO — тот же приём "задним числом": партия
  // физически изготовлена раньше, чем заводится в систему. Не задано —
  // сегодня.
  manufactured_at?: string | null;
}

export interface PartUnitEvent {
  id: number;
  event_type: string;
  quantity_delta: number;
  from_stage_id: number | null;
  to_stage_id: number | null;
  from_cell: string | null;
  to_cell: string | null;
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

// Раздел про мобильный скан-сценарий по этапам — одна партия по ID,
// зеркалит getUnit у плёнки: карточка партии открывается сканом бирки.
export const getPartUnit = async (id: number): Promise<PartUnit> => (await apiClient.get<PartUnit>(`/part-units/${id}`)).data;

// Раздел про связь этапов с участками — участок выводится из текущего
// этапа партии на бэкенде, здесь нечего передавать.
export const issuePartUnit = async (id: number): Promise<PartUnit> =>
  (await apiClient.post<PartUnit>(`/part-units/${id}/issue`)).data;

export const writeOffPartUnit = async (
  id: number,
  payload: { quantity_pieces: number; reason: string; note?: string },
): Promise<PartUnit> => (await apiClient.post<PartUnit>(`/part-units/${id}/write-off`, payload)).data;

// Раздел про мобильный скан-сценарий по этапам — прямой перевод партии
// на следующий этап, не через отчёт о производстве (для переходов без
// расхода плёнки, где заводить задание незачем).
export const advancePartUnit = async (id: number, quantityPieces: number): Promise<PartUnit> =>
  (await apiClient.post<PartUnit>(`/part-units/${id}/advance`, { quantity_pieces: quantityPieces })).data;

export const listPartUnitEvents = async (id: number): Promise<PartUnitEvent[]> =>
  (await apiClient.get<PartUnitEvent[]>(`/part-units/${id}/events`)).data;
