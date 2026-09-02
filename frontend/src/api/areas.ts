import { apiClient } from "./client";

export interface Area {
  code: string;
  name: string;
  is_active: boolean;
  // Раздел про площадки — id площадки (Северный/Фабрика), если участок к
  // ней привязан; сам склад площадки — в /sites (см. api/sites.ts).
  site_id: number | null;
  // Раздел про отключение распределения по дням — False у участков,
  // которые планируются просто "на участок", без разбивки по дням.
  requires_daily_plan: boolean;
}

export async function listAreas(): Promise<Area[]> {
  const { data } = await apiClient.get<Area[]>("/areas");
  return data;
}

export async function createArea(
  name: string,
  siteId?: number | null,
  requiresDailyPlan?: boolean,
): Promise<Area> {
  const { data } = await apiClient.post<Area>("/areas", {
    name,
    site_id: siteId ?? undefined,
    requires_daily_plan: requiresDailyPlan ?? true,
  });
  return data;
}

export async function updateArea(
  code: string,
  payload: { name?: string; is_active?: boolean; site_id?: number | null; requires_daily_plan?: boolean },
): Promise<Area> {
  const { data } = await apiClient.patch<Area>(`/areas/${code}`, payload);
  return data;
}
