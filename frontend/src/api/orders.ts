import { apiClient } from "./client";

export interface Order {
  id: number;
  number: string;
  status: string;
  created_at: string;
  closed_at: string | null;
}

export interface OrderLine {
  id: number;
  material: string;
  color: string;
  thickness: number;
  planned_area_m2: number;
  current_stock_m2: number;
  shortage: boolean;
  actual_area_m2: number;
  percent_complete: number;
  by_width: Record<string, number>;
}

export interface OrderDetail extends Order {
  lines: OrderLine[];
}

export interface OrderLineCreate {
  material: string;
  color: string;
  thickness: number;
  planned_area_m2: number;
}

export interface OrderReportLine {
  id: number;
  number: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  planned_area_m2: number;
  actual_area_m2: number;
  percent_complete: number;
  shortage_line_count: number;
}

export async function listOrders(): Promise<Order[]> {
  const { data } = await apiClient.get<Order[]>("/orders");
  return data;
}

export async function getOrder(id: number): Promise<OrderDetail> {
  const { data } = await apiClient.get<OrderDetail>(`/orders/${id}`);
  return data;
}

export interface OrderRequirement {
  part_name: string | null;
  material: string;
  color: string;
  thickness: number;
  strip_width_mm: number;
  length_m: number;
  remaining_pieces: number;
  remaining_length_m: number;
}

export async function createOrder(number?: string): Promise<Order> {
  const { data } = await apiClient.post<Order>("/orders", { number: number || undefined });
  return data;
}

export async function getOrderRequirements(orderId: number): Promise<OrderRequirement[]> {
  const { data } = await apiClient.get<OrderRequirement[]>(`/orders/${orderId}/requirements`);
  return data;
}

export async function addOrderLine(orderId: number, payload: OrderLineCreate): Promise<OrderLine> {
  const { data } = await apiClient.post<OrderLine>(`/orders/${orderId}/lines`, payload);
  return data;
}

export async function closeOrder(id: number): Promise<Order> {
  const { data } = await apiClient.post<Order>(`/orders/${id}/close`);
  return data;
}

export async function deleteOrder(id: number): Promise<void> {
  await apiClient.delete(`/orders/${id}`);
}

export async function deleteOrderLine(orderId: number, lineId: number): Promise<void> {
  await apiClient.delete(`/orders/${orderId}/lines/${lineId}`);
}

export async function getOrdersReport(): Promise<OrderReportLine[]> {
  const { data } = await apiClient.get<OrderReportLine[]>("/orders/report");
  return data;
}

export interface OrderShortageLine {
  order_id: number;
  order_number: string;
  line_id: number;
  material: string;
  color: string;
  thickness: number;
  planned_area_m2: number;
  current_stock_m2: number;
}

export async function listShortages(): Promise<OrderShortageLine[]> {
  const { data } = await apiClient.get<OrderShortageLine[]>("/orders/shortages");
  return data;
}
