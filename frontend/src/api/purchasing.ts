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
  supplier: string | null;
  price_per_m2: number | null;
}

export interface PurchaseRequestCreate {
  material: string;
  color: string;
  thickness: number;
  requested_area_m2: number;
  note?: string;
  supplier?: string;
  price_per_m2?: number;
}

export interface PurchaseRequestUpdate {
  supplier?: string;
  price_per_m2?: number;
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

export async function updatePurchaseRequest(id: number, payload: PurchaseRequestUpdate): Promise<PurchaseRequest> {
  const { data } = await apiClient.patch<PurchaseRequest>(`/purchase-requests/${id}`, payload);
  return data;
}

export async function closePurchaseRequest(id: number): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>(`/purchase-requests/${id}/close`);
  return data;
}
