import { apiClient } from "./client";

/** Контроль заказов (12.10, этап 4). */
export interface Lag {
  order_id: number;
  name: string;
  customer: string | null;
  manager: string | null;
  overdue: number;
  plan_finish: string | null;
  promised_ready: string | null;
  late: boolean;
}
export interface ReduceRow { task_line_id: number; area: string; what: string; old: number; new: number; done: number; surplus: number }
export interface DeadlineRow {
  order_id: number;
  name: string;
  customer: string | null;
  manager: string | null;
  status: string;
  promised_ready: string | null;
  ready_fact: string | null;
  ready_on_time: boolean | null;
  ship_date: string | null;
  shipped_at: string | null;
  shipped_all: boolean;
  ship_on_time: boolean | null;
  moves: number;
}

export const getLagging = async () => (await apiClient.get<Lag[]>("/order-control/lagging")).data;
export const sendLagDigest = async () => (await apiClient.post<{ orders: number }>("/order-control/lag-digest")).data;
export const reduceOrderLine = async (orderId: number, lineId: number, quantity: number, reason: string | null, apply: boolean) =>
  (await apiClient.post<{ rows: ReduceRow[]; merged: string[]; applied: boolean }>(`/production-orders/${orderId}/lines/${lineId}/reduce`, { quantity, reason, apply })).data;
export const cancelOrder = async (orderId: number, reason: string) => (await apiClient.post(`/production-orders/${orderId}/cancel`, { reason })).data;
export const getDeadlines = async (dateFrom: string, dateTo: string) =>
  (await apiClient.get<{ rows: DeadlineRow[]; by_manager: Record<string, { orders: number; on_time: number; late: number }>; reasons: [string, number][] }>(
    "/order-control/deadlines",
    { params: { date_from: dateFrom, date_to: dateTo } },
  )).data;
