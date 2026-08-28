import { apiClient } from "./client";

export interface Site {
  id: number;
  name: string;
  warehouse_id: number;
  is_active: boolean;
}

export async function listSites(): Promise<Site[]> {
  const { data } = await apiClient.get<Site[]>("/sites");
  return data;
}

export async function createSite(name: string, warehouseId: number): Promise<Site> {
  const { data } = await apiClient.post<Site>("/sites", { name, warehouse_id: warehouseId });
  return data;
}

export async function updateSite(
  id: number,
  payload: { name?: string; warehouse_id?: number; is_active?: boolean },
): Promise<Site> {
  const { data } = await apiClient.patch<Site>(`/sites/${id}`, payload);
  return data;
}
