import { apiClient } from "./client";

// Заказ на производство (единая модель, пункт 4): позиции любого вида и
// количества; запуск раскладывает заказ по маршрутам на задания участкам.

export type OrderStatus = "draft" | "released" | "closed";

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  draft: "Черновик",
  released: "Запущен",
  closed: "Закрыт",
};

export interface OrderOperation {
  stage_id: number;
  name: string;
  area: string | null;
  area_name: string | null;
  task_id: number | null;
  task_line_id: number | null;
  good: number;
  defect: number;
  remaining: number;
}

export interface OrderComponent {
  item_id: number;
  name: string;
  per_unit: number;
  total: number;
  unit: string;
  operation_name: string | null;
}

export interface OrderLine {
  id: number;
  item_id: number;
  item_name: string;
  kind_name: string;
  quantity: number;
  note: string | null;
  done: number;
  operations: OrderOperation[];
  components: OrderComponent[];
}

export interface ProductionOrder {
  id: number;
  name: string;
  ship_date: string | null;
  note: string | null;
  status: OrderStatus;
  created_by_name: string;
  created_at: string;
  released_at: string | null;
  task_ids: number[];
  lines: OrderLine[];
  /** Задания участкам внутри заказа. */
  tasks: OrderTask[];
  /** План: последний день плана, не успевает к отгрузке, просрочено штук. */
  plan_finish?: string | null;
  plan_late?: boolean;
  plan_overdue?: number;
  planned?: boolean;
}

/** П/ф под заказ — что запустить вместе с ним (по составу вглубь). */
export interface PfNeed {
  order_line_id: number;
  part_id: number;
  part_name: string;
  quantity: number;
  consumer_part_id: number | null;
  depth: number;
  free_stock: number;
  lamination_area: string | null;
  factory_area: string | null;
  factory_min_pieces: number | null;
  /** Предложено взять со склада (в резерв под заказ) и запустить; режим детали. */
  from_stock?: number;
  launch?: number;
  mode?: string | null;
}

export interface PfPick {
  order_line_id: number;
  part_id: number;
  quantity: number;
  consumer_part_id: number | null;
  lamination_area?: string | null;
  /** Взять со склада — в резерв под задание, где деталь расходуется. */
  from_stock?: number;
}

export const getReleasePreview = async (orderId: number): Promise<PfNeed[]> =>
  (await apiClient.get<PfNeed[]>(`/production-orders/${orderId}/release-preview`)).data;

export const rescheduleOrder = async (orderId: number): Promise<ProductionOrder> =>
  (await apiClient.post<ProductionOrder>(`/production-orders/${orderId}/schedule`)).data;

export interface OrderTask {
  id: number;
  name: string;
  area: string;
  area_name: string | null;
  is_active: boolean;
  for_task_id: number | null;
  lines_count: number;
  planned: number;
  done: number;
  with_film: boolean;
  with_parts: boolean;
  plan_from?: string | null;
  plan_to?: string | null;
}

export interface OrderInput {
  name: string;
  ship_date: string | null;
  note: string | null;
  lines: { item_id: number; quantity: number; note: string | null }[];
}

/** itemId — заказы с этой позицией; modelId — с любым вариантом модели. */
export const listProductionOrders = async (includeClosed: boolean, itemId?: number, modelId?: number): Promise<ProductionOrder[]> =>
  (
    await apiClient.get<ProductionOrder[]>("/production-orders", {
      params: { include_closed: includeClosed, item_id: itemId, model_id: modelId },
    })
  ).data;

export const createProductionOrder = async (payload: OrderInput): Promise<ProductionOrder> =>
  (await apiClient.post<ProductionOrder>("/production-orders", payload)).data;

export const updateProductionOrder = async (id: number, payload: OrderInput): Promise<ProductionOrder> =>
  (await apiClient.put<ProductionOrder>(`/production-orders/${id}`, payload)).data;

export const deleteProductionOrder = async (id: number): Promise<void> => {
  await apiClient.delete(`/production-orders/${id}`);
};

/** Запуск: задания участкам, п/ф под заказ (pf) и сроки назад от отгрузки. */
export const releaseProductionOrder = async (id: number, pf: PfPick[] = []): Promise<ProductionOrder> =>
  (await apiClient.post<ProductionOrder>(`/production-orders/${id}/release`, { pf })).data;

export const closeProductionOrder = async (id: number): Promise<ProductionOrder> =>
  (await apiClient.post<ProductionOrder>(`/production-orders/${id}/close`)).data;

export interface ScheduleImportRow {
  series: string;
  size: string;
  color: string;
  name_text: string;
  qty: number;
  invoice_no: string;
  ship_date: string | null;
  item_name: string | null;
  exists: boolean;
  errors: string[];
}

/** График запуска, вставленный из Excel → черновик заказа (dry_run — предпросмотр). */
export const importOrderFromSchedule = async (payload: {
  text: string;
  type_id: number;
  name: string | null;
  dry_run: boolean;
}): Promise<{ rows: ScheduleImportRow[]; parse_errors: string[]; order: ProductionOrder | null }> =>
  (await apiClient.post("/production-orders/from-schedule", payload)).data;

/** Готовность заказа для продажника (без заданий и участков). */
export interface OrderReadiness {
  id: number;
  name: string;
  status: string;
  ship_date: string | null;
  plan_finish: string | null;
  plan_late: boolean;
  plan_overdue: number;
  planned: boolean;
  quantity: number;
  done: number;
  lines: { item_name: string; quantity: number; done: number }[];
  /** Этапы заказа: операции изделия, «П/ф» одной колонкой. */
  stages: ReadinessStage[];
}

export interface ReadinessStage {
  name: string;
  seq: number;
  plan: number;
  done: number;
  plan_date: string | null;
  status: "done" | "progress" | "planned" | "overdue" | "none";
}

export const getOrdersReadiness = async (includeClosed = false): Promise<OrderReadiness[]> =>
  (await apiClient.get<OrderReadiness[]>("/production-orders/readiness", { params: { include_closed: includeClosed } })).data;
