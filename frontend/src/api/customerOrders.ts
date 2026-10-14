import { apiClient } from "./client";
import type { PlanCheck, ScheduleImportColor, ScheduleImportRow } from "./productionOrders";

// Заказ клиента (13.10) — один счёт 1С. Менеджер заводит и отправляет в
// производство; производство принимает с датами и собирает принятые заказы
// в заказ на производство (запуск).

export type CustomerOrderStatus = "draft" | "submitted" | "returned" | "accepted" | "cancelled";
export type CustomerOrderStage =
  | "draft"
  | "submitted"
  | "returned"
  | "accepted"
  | "assembled"
  | "in_production"
  | "ready"
  | "shipped_part"
  | "shipped"
  | "cancelled";

export const STAGE_COLOR: Record<CustomerOrderStage, string> = {
  draft: "default",
  submitted: "gold",
  returned: "volcano",
  accepted: "cyan",
  assembled: "geekblue",
  in_production: "blue",
  ready: "green",
  shipped_part: "purple",
  shipped: "default",
  cancelled: "default",
};

export interface CustomerOrderLine {
  id: number;
  item_id: number;
  item_name: string;
  quantity: number;
  /** Сколько уже в заказах на производство. */
  launched: number;
  note: string | null;
}

export interface CustomerDateChange {
  field: "ship" | "ready" | "ready_fact";
  old_date: string | null;
  new_date: string | null;
  reason_name: string | null;
  comment: string | null;
  user_name: string | null;
  created_at: string;
}

export interface CustomerOrder {
  id: number;
  invoice_no: string;
  invoice_date: string | null;
  customer: string | null;
  manager_id: number | null;
  manager_name: string | null;
  amount_rub: number | null;
  priority: number;
  ship_from: string | null;
  ship_to: string | null;
  promised_ready: string | null;
  ship_date: string | null;
  status: CustomerOrderStatus;
  stage: CustomerOrderStage;
  stage_label: string;
  request_comment: string | null;
  submitted_at: string | null;
  decided_by_name: string | null;
  note: string | null;
  created_at: string;
  qty: number;
  launched: number;
  in_work: number;
  received: number;
  shipped: number;
  ready_fact: string | null;
  last_shipped_at: string | null;
  plan_finish: string | null;
  plan_late: boolean;
  production_orders: { id: number; name: string; status: string }[];
  lines: CustomerOrderLine[];
  date_changes: CustomerDateChange[];
  /** сделка Битрикс24 (14.10) */
  bitrix_deal_id?: number | null;
  bitrix_deal_url?: string | null;
  bitrix_deals_on?: boolean;
}

export interface CustomerOrderInput {
  invoice_no: string;
  invoice_date: string | null;
  customer: string | null;
  amount_rub: number | null;
  priority: number;
  ship_from: string | null;
  ship_to: string | null;
  note: string | null;
  lines: { item_id: number; quantity: number; note: string | null }[];
}

const base = "/customer-orders";

/** Календарь (14.10): по заказу и участку — план по дням, факт по концу дня. */
export interface CalendarArea {
  area: string;
  area_name: string;
  need: number;
  done: number;
  /** запланировано на прошедшие дни, но не сделано */
  overdue: number;
  /** "YYYY-MM-DD" → [план, факт] */
  days: Record<string, [number, number]>;
}
export interface CalendarRow {
  key: string; // "co:12" | "po:34"
  kind: "co" | "po";
  id: number;
  title: string;
  customer: string | null;
  status: string;
  ship_date: string | null;
  promised_ready: string | null;
  plan_finish: string | null;
  released: boolean;
  areas: CalendarArea[];
  /** у заказа на производство: [название, шт] */
  items: [string, number][];
  note: string | null;
  last_fact: string | null;
  overdue: number;
}
/** Произведено за день по участку и план дня — по всем заданиям цеха. */
export interface CalendarTotal {
  area: string;
  area_name: string;
  days: Record<string, [number, number]>;
}
export const getCalendarTotals = async (dateFrom: string, dateTo: string): Promise<CalendarTotal[]> =>
  (await apiClient.get<CalendarTotal[]>("/customer-orders/calendar/totals", { params: { date_from: dateFrom, date_to: dateTo } })).data;
export const getOrderCalendar = async (dateFrom: string, dateTo: string): Promise<CalendarRow[]> =>
  (await apiClient.get<CalendarRow[]>("/customer-orders/calendar", { params: { date_from: dateFrom, date_to: dateTo } })).data;

export interface BitrixDeal { id: number; title: string; stage: string; amount: number | null; created: string | null; url: string | null }
export const findBitrixDeals = async (orderId: number): Promise<BitrixDeal[]> =>
  (await apiClient.get<BitrixDeal[]>(`/customer-orders/${orderId}/bitrix-deals`)).data;
export const setBitrixDeal = async (orderId: number, payload: { deal?: string; create?: boolean; unlink?: boolean }): Promise<CustomerOrder> =>
  (await apiClient.post<CustomerOrder>(`/customer-orders/${orderId}/bitrix-deal`, payload)).data;

export const listCustomerOrders = async (includeClosed = false): Promise<CustomerOrder[]> =>
  (await apiClient.get<CustomerOrder[]>(base, { params: { include_closed: includeClosed } })).data;
export const getCustomerOrder = async (id: number): Promise<CustomerOrder> => (await apiClient.get<CustomerOrder>(`${base}/${id}`)).data;
export const createCustomerOrder = async (p: CustomerOrderInput): Promise<CustomerOrder> => (await apiClient.post<CustomerOrder>(base, p)).data;
export const updateCustomerOrder = async (id: number, p: CustomerOrderInput): Promise<CustomerOrder> =>
  (await apiClient.put<CustomerOrder>(`${base}/${id}`, p)).data;
export const deleteCustomerOrder = async (id: number): Promise<void> => {
  await apiClient.delete(`${base}/${id}`);
};
export const submitCustomerOrder = async (id: number, comment: string | null): Promise<CustomerOrder> =>
  (await apiClient.post<CustomerOrder>(`${base}/${id}/submit`, { comment })).data;
export const returnCustomerOrder = async (id: number, comment: string): Promise<CustomerOrder> =>
  (await apiClient.post<CustomerOrder>(`${base}/${id}/return`, { comment })).data;
export const acceptCustomerOrder = async (id: number, shipDate: string, readyDate: string | null, comment: string | null): Promise<CustomerOrder> =>
  (await apiClient.post<CustomerOrder>(`${base}/${id}/accept`, { ship_date: shipDate, ready_date: readyDate, comment })).data;
/** Менеджер — вилку (до приёма); производство — обещанные даты, после приёма с причиной. */
export const moveCustomerOrder = async (
  id: number,
  p: { ship_from?: string | null; ship_to?: string | null; ship_date?: string | null; ready_date?: string | null; ready_fact?: string | null; reason?: string | null; comment?: string | null },
): Promise<CustomerOrder> => (await apiClient.post<CustomerOrder>(`${base}/${id}/promise`, p)).data;
export const cancelCustomerOrder = async (id: number, reason: string): Promise<CustomerOrder> =>
  (await apiClient.post<CustomerOrder>(`${base}/${id}/cancel`, { reason })).data;
export const getCustomerPlanCheck = async (id: number): Promise<PlanCheck> => (await apiClient.get<PlanCheck>(`${base}/${id}/plan-check`)).data;
export const launchCustomerOrders = async (orderIds: number[], name: string | null): Promise<{ production_order_id: number }> =>
  (await apiClient.post<{ production_order_id: number }>(`${base}/launch`, { order_ids: orderIds, name })).data;

export interface CustomerImportResult {
  rows: ScheduleImportRow[];
  problems: string[];
  invoices: string[];
  colors: ScheduleImportColor[];
  created: number[];
}
export const importCustomerOrders = async (p: {
  text: string;
  type_id: number;
  invoice_no: string | null;
  customer: string | null;
  ship_from: string | null;
  ship_to: string | null;
  dry_run: boolean;
  color_films: Record<string, number>;
}): Promise<CustomerImportResult> => (await apiClient.post<CustomerImportResult>(`${base}/import`, p)).data;
