import { apiClient } from "./client";

export interface Area {
  code: string;
  name: string;
  is_active: boolean;
}

export async function listAreas(): Promise<Area[]> {
  const { data } = await apiClient.get<Area[]>("/areas");
  return data;
}

export async function createArea(name: string): Promise<Area> {
  const { data } = await apiClient.post<Area>("/areas", { name });
  return data;
}

export async function updateArea(code: string, payload: { name?: string; is_active?: boolean }): Promise<Area> {
  const { data } = await apiClient.patch<Area>(`/areas/${code}`, payload);
  return data;
}
