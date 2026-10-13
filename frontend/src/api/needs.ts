import { apiClient } from "./client";

/** Потребность по заказам (12.10, этап 2). */
export interface NeedRow {
  kind: "film" | "material";
  key: string;
  name: string;
  unit: string;
  need: number;
  allocated: number;
  shortage: number;
  need_by: string | null;
  incoming: number;
  incoming_date: string | null;
}
export interface OrderNeeds {
  order_id: number;
  name: string;
  group: string;
  priority: number;
  date: string | null;
  rows: NeedRow[];
  fg: { item_id: number; name: string; need: number; free: number }[];
  error: string | null;
  /** Строка — незапущенный остаток заказа клиента (order_id — его id). */
  customer_order_id?: number | null;
}
export interface ShortageRow {
  kind: "film" | "material";
  key: string;
  name: string;
  unit: string;
  shortage: number;
  need_by: string | null;
  orders: { order_id: number; customer_order_id?: number | null; name: string; group: string; shortage: number; need_by: string | null }[];
}

export const getOrderNeeds = async (orderId: number): Promise<OrderNeeds | null> =>
  (await apiClient.get<OrderNeeds | null>(`/needs/orders/${orderId}`)).data;
export const getCustomerOrderNeeds = async (id: number): Promise<OrderNeeds | null> =>
  (await apiClient.get<OrderNeeds | null>(`/needs/customer-orders/${id}`)).data;
export const getNeedsOverview = async (): Promise<{ shortages: ShortageRow[]; orders: OrderNeeds[] }> =>
  (await apiClient.get<{ shortages: ShortageRow[]; orders: OrderNeeds[] }>("/needs")).data;
export const purchaseShortages = async (
  items: { key: string; qty: number; need_by: string | null; order_ids: number[]; labels?: string[] }[],
  comment: string | null = null,
): Promise<{ film_requests: number[]; bitrix_tasks: number; not_sent: string[] }> =>
  (await apiClient.post("/needs/purchase", { items, comment })).data;
