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
  /** вид позиции: запуск по видам — погонаж отдельно от дверей (20.10) */
  kind_name?: string | null;
  /** код вида: trim / shield / tsarg / panel — сделки по видам */
  direction?: string | null;
  /** принято на склад ГП: по запуску или «Готово…» без запуска (20.10) */
  received?: number;
  /** исполнение (26.10): цвет кромки, тип стекла, уплотнитель… */
  options?: LineOption[];
  option_fields?: OptionField[];
  source_text?: string | null;
}

/** Выбор исполнения строки (26.10). */
export interface LineOption {
  code: string;
  name: string;
  value: string;
  op?: string | null;
}
/** Какой выбор можно задать строке: варианты списка или свободный текст. */
export interface OptionField {
  code: string;
  name: string;
  op?: string | null;
  value_type: string;
  options: string[];
}

export const setCustomerLineOptions = async (orderId: number, lineId: number, options: LineOption[]): Promise<CustomerOrder> =>
  (await apiClient.patch<CustomerOrder>(`/customer-orders/${orderId}/lines/${lineId}/options`, { options })).data;

export interface CustomerDateChange {
  field: "ship" | "ready" | "ready_fact" | "ship_to";
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
  /** сделки по видам (20.10): каждая ведёт свои строки; direction пусто — весь заказ */
  bitrix_deals?: { deal_id: number; direction: string | null; direction_label: string; title: string | null; url: string | null; stage: string }[];
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
  lines: { item_id: number; quantity: number; note: string | null; options?: LineOption[] | null }[];
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
export const setBitrixDeal = async (
  orderId: number,
  payload: { deal?: string; create?: boolean; unlink?: boolean; direction?: string | null },
): Promise<CustomerOrder> =>
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
/** Что нужно заказу к приёму (28.10): в конце очереди, после принятого и отправленного. */
export interface IntakeNeeds {
  group: string | null;
  error: string | null;
  rows: { kind: string; name: string; unit: string; need: number; allocated: number; shortage: number; incoming: number; incoming_date: string | null }[];
  fg: { item_id: number; name: string; need: number; free: number }[];
}
export const getCustomerIntakeNeeds = async (id: number): Promise<IntakeNeeds> => (await apiClient.get<IntakeNeeds>(`${base}/${id}/intake-needs`)).data;
/** Массовый приём (28.10): всё или ничего; launch — сразу черновик заказа на производство. */
export const acceptManyCustomerOrders = async (p: {
  orders: { order_id: number; ship_date: string | null; ready_date: string | null }[];
  comment: string | null;
  launch: boolean;
  launch_name: string | null;
}): Promise<{ accepted: number[]; production_order_id: number | null }> => (await apiClient.post(`${base}/accept-many`, p)).data;
/** Загрузка участков, если принять и запустить выбранные (28.10). */
export const getIntakeLoad = async (orderIds: number[]): Promise<PlanCheck> =>
  (await apiClient.post<PlanCheck>(`${base}/intake-load`, { order_ids: orderIds })).data;
export const returnManyCustomerOrders = async (orderIds: number[], comment: string): Promise<{ returned: number[] }> =>
  (await apiClient.post(`${base}/return-many`, { order_ids: orderIds, comment })).data;
export const getCustomerPlanCheck = async (id: number): Promise<PlanCheck> => (await apiClient.get<PlanCheck>(`${base}/${id}/plan-check`)).data;
/** lineIds — только эти строки (20.10): погонаж и двери одного счёта запускаются отдельно. */
export const launchCustomerOrders = async (orderIds: number[], name: string | null, lineIds?: number[]): Promise<{ production_order_id: number }> =>
  (await apiClient.post<{ production_order_id: number }>(`${base}/launch`, { order_ids: orderIds, name, line_ids: lineIds ?? null })).data;

/** «Готово…» по строке принятого заказа без запуска (20.10): приход на склад ГП. */
export const markCustomerLineReady = async (orderId: number, lineId: number, qty: number): Promise<CustomerOrder> =>
  (await apiClient.post<CustomerOrder>(`${base}/${orderId}/lines/${lineId}/ready`, { qty })).data;

export interface CustomerImportResult {
  rows: ScheduleImportRow[];
  problems: string[];
  invoices: string[];
  colors: ScheduleImportColor[];
  created: number[];
  /** заказы, которые уже есть по этим счетам (20.10): дополняются, а не дублируются */
  merges?: { invoice: string; order_id: number; order_invoice: string; status: string }[];
  updated?: number[];
}
/** Выгрузка счёта из 1С (.xls/.xlsx, 16.10): номер счёта — имя файла, строки — текстом для импорта. */
export const readInvoiceFile = async (file: File) => {
  const fd = new FormData();
  fd.append("file", file);
  return (
    await apiClient.post<{ invoice_no: string; invoice_date: string | null; text: string; lines: number; problems: string[] }>(`${base}/invoice-file`, fd, {
      headers: { "Content-Type": "multipart/form-data" },
    })
  ).data;
};

export const importCustomerOrders = async (p: {
  text: string;
  type_id: number | null;
  invoice_no: string | null;
  /** дата счёта (28.10) */
  invoice_date?: string | null;
  customer: string | null;
  ship_from: string | null;
  ship_to: string | null;
  dry_run: boolean;
  color_films: Record<string, number>;
  /** заказ из сделки Битрикс24: сделка привяжется, сумма и менеджер — из неё */
  bitrix_deal_id?: number | null;
  bitrix_deal_title?: string | null;
  item_choices?: Record<string, number>;
  amount_rub?: number | null;
  manager_bitrix_id?: number | null;
}): Promise<CustomerImportResult> => (await apiClient.post<CustomerImportResult>(`${base}/import`, p)).data;

/** Сделка воронки Битрикс24 против заказов клиентов (19.10). */
export interface FunnelDeal {
  id: number;
  title: string;
  invoice: string | null;
  kind: string | null;
  qty: number | null;
  amount: number | null;
  stage: string;
  stage_name: string;
  closed: boolean;
  company: string | null;
  assigned: string | null;
  assigned_bx: number | null;
  created: string | null;
  url: string | null;
  /** «Дата отгрузки» сделки (20.10) */
  ship_date?: string | null;
  /** linked — у заказа; match — один подходящий заказ; many — несколько; none — заказа нет */
  state: "linked" | "match" | "many" | "none";
  order_id: number | null;
  order_invoice: string | null;
  order_stage: string | null;
  candidates: { id: number; invoice: string; customer: string | null }[];
}

export interface Funnel {
  deals: FunnelDeal[];
  orders_without_deal: { id: number; invoice: string; customer: string | null; stage: string }[];
  sync_enabled: boolean;
  auto_create: boolean;
  loaded_at: number;
}

/** Сделки Битрикса в календаре заказов (20.10): открытые, без заказа клиента. */
export const getCalendarDeals = async (dateFrom: string, dateTo: string) =>
  (
    await apiClient.get<{ dated: FunnelDeal[]; undated: FunnelDeal[]; connected: boolean }>(`${base}/calendar/deals`, {
      params: { date_from: dateFrom, date_to: dateTo },
    })
  ).data;
export const getBitrixFunnel = async (refresh = false) =>
  (await apiClient.get<Funnel>(`${base}/bitrix/funnel`, { params: { refresh } })).data;
export const linkAllBitrixDeals = async () => (await apiClient.post<{ linked: number }>(`${base}/bitrix/link-all`)).data;
export const linkBitrixDeal = async (orderId: number, dealId: number) =>
  (await apiClient.post(`${base}/${orderId}/bitrix-deal`, { deal: String(dealId) })).data;
