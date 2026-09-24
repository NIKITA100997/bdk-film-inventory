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
}

export interface OrderInput {
  name: string;
  ship_date: string | null;
  note: string | null;
  lines: { item_id: number; quantity: number; note: string | null }[];
}

export const listProductionOrders = async (includeClosed: boolean): Promise<ProductionOrder[]> =>
  (await apiClient.get<ProductionOrder[]>("/production-orders", { params: { include_closed: includeClosed } })).data;

export const createProductionOrder = async (payload: OrderInput): Promise<ProductionOrder> =>
  (await apiClient.post<ProductionOrder>("/production-orders", payload)).data;

export const updateProductionOrder = async (id: number, payload: OrderInput): Promise<ProductionOrder> =>
  (await apiClient.put<ProductionOrder>(`/production-orders/${id}`, payload)).data;

export const deleteProductionOrder = async (id: number): Promise<void> => {
  await apiClient.delete(`/production-orders/${id}`);
};

export const releaseProductionOrder = async (id: number): Promise<ProductionOrder> =>
  (await apiClient.post<ProductionOrder>(`/production-orders/${id}/release`)).data;

export const closeProductionOrder = async (id: number): Promise<ProductionOrder> =>
  (await apiClient.post<ProductionOrder>(`/production-orders/${id}/close`)).data;
