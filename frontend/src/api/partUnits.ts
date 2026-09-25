import { apiClient } from "./client";

// Физическая партия деталей (лот в штуках, зеркалит MaterialUnit) —
// раздел про физический учёт деталей (пилот: окутка царговых).
// В_переработку — раздел про переработку брака: резерв (материал
// физически остаётся на месте), не потеря — забрать его в готовую
// деталь можно действием "Переработать в деталь" (recyclePartUnits).
export type PartUnitStatus = "На_хранении" | "Выдан_участку" | "Списан" | "В_переработку";

export interface PartUnit {
  id: number;
  parent_id: number | null;
  part_id: number;
  part_name: string;
  quantity_pieces: number;
  // Раздел про ревизию путей п/ф — сколько реально доступно сейчас
  // (quantity_pieces за вычетом уже отчитанного по FIFO) — партия,
  // полностью взятая в отчёт на последнем этапе, не уменьшает
  // quantity_pieces и выглядит доступной снова, если смотреть только
  // на него.
  quantity_available: number;
  stage_id: number;
  stage_name: string;
  status: PartUnitStatus;
  area: string | null;
  location_code: string | null;
  production_task_line_id: number | null;
  note: string | null;
  // Раздел про совместимость с плёнкой — код из справочника
  // PartFilmRestriction ("ламис"/"с кромкой"/"аляска" и т.п.), только
  // видимая пометка на партии, не участвует в подборе по FIFO.
  film_restriction: string | null;
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
  note?: string | null;
  // Раздел про регистрацию задним числом — партия уже прошла часть
  // маршрута (например, уже склеена и отфрезерована), заводим её сразу
  // на этом этапе. Не задано — как раньше, первый этап детали.
  stage_id?: number | null;
  // Раздел про учёт п/ф по FIFO — тот же приём "задним числом": партия
  // физически изготовлена раньше, чем заводится в систему. Не задано —
  // сегодня.
  manufactured_at?: string | null;
  // Раздел про совместимость с плёнкой — код из справочника
  // PartFilmRestriction, если у этой конкретной партии есть ограничение.
  film_restriction?: string | null;
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
  // Раздел про переработку брака — на событии "Переработка" партии-
  // источника: id новой партии, в которую она переработалась.
  related_part_unit_id: number | null;
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

export const writeOffPartUnit = async (
  id: number,
  payload: { quantity_pieces: number; reason: string; note?: string; occurred_at?: string | null },
): Promise<PartUnit> => (await apiClient.post<PartUnit>(`/part-units/${id}/write-off`, payload)).data;

// Раздел про мобильный скан-сценарий по этапам — прямой перевод партии
// на следующий этап, не через отчёт о производстве (для переходов без
// расхода плёнки, где заводить задание незачем).
// «Сделать деталь из заготовки» (общая заготовка до фрезеровки → деталь с
// пазом): заготовка списывается в производство, партия детали рождается
// уже после операции (у МК — сразу на «Окутке»).
export interface MakeTarget {
  part_id: number;
  part_name: string;
  operation: string;
  per_unit: number;
}

export const listMakeSourceParts = async (): Promise<number[]> =>
  (await apiClient.get<number[]>("/part-units/make-source-parts")).data;

export const getMakeTargets = async (unitId: number): Promise<MakeTarget[]> =>
  (await apiClient.get<MakeTarget[]>(`/part-units/${unitId}/make-targets`)).data;

export const makeFromPartUnit = async (
  unitId: number,
  payload: { target_part_id: number; quantity_pieces: number; occurred_at?: string | null },
): Promise<PartUnit> => (await apiClient.post<PartUnit>(`/part-units/${unitId}/make`, payload)).data;

// «Передать на участок» — партию «На хранении» (например, возвращённую на
// склад) на участок её этапа. quantityPieces не задано — всю партию.
export const issuePartUnit = async (id: number, quantityPieces?: number | null): Promise<PartUnit> =>
  (await apiClient.post<PartUnit>(`/part-units/${id}/issue`, { quantity_pieces: quantityPieces ?? null })).data;

export const advancePartUnit = async (id: number, quantityPieces: number, occurredAt?: string | null): Promise<PartUnit> =>
  (await apiClient.post<PartUnit>(`/part-units/${id}/advance`, { quantity_pieces: quantityPieces, occurred_at: occurredAt })).data;

export const listPartUnitEvents = async (id: number): Promise<PartUnitEvent[]> =>
  (await apiClient.get<PartUnitEvent[]>(`/part-units/${id}/events`)).data;

// Раздел про ревизию путей п/ф — вернуть партию на склад, не
// использовав (или использовав лишь частично), зеркалит returnUnit у
// плёнки.
export const returnPartUnit = async (id: number, actualQuantityPieces: number, occurredAt?: string | null): Promise<PartUnit> =>
  (await apiClient.post<PartUnit>(`/part-units/${id}/return`, { actual_quantity_pieces: actualQuantityPieces, occurred_at: occurredAt })).data;

// Раздел про ревизию путей плёнки/п/ф — формальная корректировка
// quantity_pieces вместо правки истории напрямую в БД: поднадзорное
// действие, всегда добавляет событие, причина обязательна.
export const adjustPartUnit = async (
  id: number,
  payload: {
    actual_quantity_pieces: number;
    reason: string;
    note?: string;
    film_restriction?: string | null;
    clear_film_restriction?: boolean;
    occurred_at?: string | null;
  },
): Promise<PartUnit> => (await apiClient.post<PartUnit>(`/part-units/${id}/adjust`, payload)).data;

// Раздел про переработку брака — "Переработать в деталь": забрать резерв
// (В_переработку) исходной детали по FIFO и заминтить новую партию ДРУГОЙ
// детали сразу на её этапе "Окутка".
export const recyclePartUnits = async (payload: {
  source_part_id: number;
  area: string;
  quantity_pieces: number;
  target_part_id: number;
  note?: string;
}): Promise<PartUnit> => (await apiClient.post<PartUnit>("/part-units/recycle", payload)).data;
