import { apiClient } from "./client";

export interface Supplier {
  id: number;
  name: string;
  contact: string | null;
  is_active: boolean;
}

export interface SupplierCreate {
  name: string;
  contact?: string;
}

export interface SupplierUpdate {
  name?: string;
  contact?: string;
  is_active?: boolean;
}

export interface SupplierStats {
  supplier_id: number;
  supplier_name: string;
  closed_requests: number;
  avg_price_per_m2: number | null;
  avg_lead_time_days: number | null;
  last_request_at: string;
}

export async function listSuppliers(): Promise<Supplier[]> {
  const { data } = await apiClient.get<Supplier[]>("/suppliers");
  return data;
}

export async function createSupplier(payload: SupplierCreate): Promise<Supplier> {
  const { data } = await apiClient.post<Supplier>("/suppliers", payload);
  return data;
}

export async function updateSupplier(id: number, payload: SupplierUpdate): Promise<Supplier> {
  const { data } = await apiClient.patch<Supplier>(`/suppliers/${id}`, payload);
  return data;
}

export async function getSupplierStats(): Promise<SupplierStats[]> {
  const { data } = await apiClient.get<SupplierStats[]>("/suppliers/stats/history");
  return data;
}
