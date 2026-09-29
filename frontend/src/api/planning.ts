import { apiClient } from "./client";

// Планировщик производства (backend/app/api/planning.py): сетка «участки ×
// рабочие дни» по слотам плана, перенос и деление, строки без плана.

export interface PlanArea {
  code: string;
  name: string;
  site: string | null;
  /** Мощность в день (штук в смену × смен); null — не задана. */
  capacity: number | null;
}

export interface PlanCell {
  area: string;
  date: string;
  quantity: number;
  lines: number;
  /** Прошедший день: запланировано и не сделано. */
  overdue: number;
}

export interface PlanBacklog {
  area: string;
  lines: number;
  quantity: number;
}

export interface PlanBoard {
  days: string[];
  areas: PlanArea[];
  cells: PlanCell[];
  backlog: PlanBacklog[];
}

export interface PlanSlot {
  /** null — строка без плана. */
  id: number | null;
  date: string | null;
  quantity: number;
  auto: boolean;
  overdue: boolean;
  task_line_id: number;
  task_id: number;
  task_name: string;
  area: string;
  what: string;
  operation: string | null;
  line_plan: number;
  line_done: number;
  order_id: number | null;
  order_name: string | null;
  ship_date: string | null;
}

export const getPlanBoard = async (params: { date_from?: string; date_to?: string; site_id?: number }): Promise<PlanBoard> =>
  (await apiClient.get<PlanBoard>("/planning/board", { params })).data;

export const listPlanSlots = async (params: {
  area: string;
  date_from?: string;
  date_to?: string;
  unplanned?: boolean;
  include_earlier?: boolean;
}): Promise<PlanSlot[]> => (await apiClient.get<PlanSlot[]>("/planning/slots", { params })).data;

export const movePlanSlot = async (
  id: number,
  payload: { date?: string; quantity?: number; shift_next?: boolean },
): Promise<void> => {
  await apiClient.patch(`/planning/slots/${id}`, payload);
};

export const splitPlanSlot = async (
  id: number,
  payload: { date: string; quantity: number; shift_next?: boolean },
): Promise<void> => {
  await apiClient.post(`/planning/slots/${id}/split`, payload);
};

export const planLine = async (lineId: number, payload: { date: string; quantity: number }): Promise<void> => {
  await apiClient.post(`/planning/lines/${lineId}/slots`, payload);
};

/** Перетащили клетку «участок × день» на другой день: все её слоты туда. */
export const movePlanCell = async (payload: {
  area: string;
  from_date: string;
  to_date: string;
  include_earlier?: boolean;
  shift_next?: boolean;
}): Promise<{ moved: number }> => (await apiClient.post("/planning/cells/move", payload)).data;

export interface MoveCheckIn {
  to_date: string;
  slot_id?: number;
  split?: boolean;
  cell?: { area: string; from_date: string; to_date: string; include_earlier?: boolean };
}

export interface MoveCheck {
  conflicts: { what: string; operation: string | null; area_name: string; relation: "next" | "prev"; start: string; need: string }[];
  will_shift: { what: string; operation: string | null; area_name: string; before: string; after: string }[];
}

/** Проверка переноса: не нарушится ли порядок связанных этапов. */
export const checkPlanMove = async (payload: MoveCheckIn): Promise<MoveCheck> =>
  (await apiClient.post<MoveCheck>("/planning/check-move", payload)).data;
