import { apiClient } from "./client";

export interface Order {
  id: number;
  number: string;
  status: string;
  created_at: string;
  closed_at: string | null;
}

export async function listOrders(): Promise<Order[]> {
  const { data } = await apiClient.get<Order[]>("/orders");
  return data;
}

export async function createOrder(number: string): Promise<Order> {
  const { data } = await apiClient.post<Order>("/orders", { number });
  return data;
}

export async function closeOrder(id: number): Promise<Order> {
  const { data } = await apiClient.post<Order>(`/orders/${id}/close`);
  return data;
}
