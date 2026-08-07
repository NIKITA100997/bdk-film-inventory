import { apiClient } from "./client";

export interface PurchaseRequest {
  id: number;
  material: string;
  color: string;
  thickness: number;
  requested_area_m2: number;
  current_stock_m2: number;
  note: string | null;
  status: string;
  created_by: number;
  created_at: string;
  closed_at: string | null;
}

export interface PurchaseRequestCreate {
  material: string;
  color: string;
  thickness: number;
  requested_area_m2: number;
  note?: string;
}

export async function listPurchaseRequests(statusFilter?: string): Promise<PurchaseRequest[]> {
  const { data } = await apiClient.get<PurchaseRequest[]>("/purchase-requests", {
    params: statusFilter ? { status_filter: statusFilter } : undefined,
  });
  return data;
}

export async function createPurchaseRequest(payload: PurchaseRequestCreate): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>("/purchase-requests", payload);
  return data;
}

export async function closePurchaseRequest(id: number): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>(`/purchase-requests/${id}/close`);
  return data;
}
