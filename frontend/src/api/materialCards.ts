import { apiClient } from "./client";
import type { MaterialSku, MaterialUnit } from "./units";

export interface MaterialCardPlanFact {
  order_count: number;
  planned_area_m2: number;
  actual_area_m2: number;
  percent_complete: number;
  by_width: Record<string, number>;
}

export interface MaterialEvent {
  event_id: number;
  unit_id: number;
  event_type: string;
  area: string | null;
  timestamp: string;
  user_id: number;
  width_mm: number;
  from_length: number | null;
  to_length: number | null;
  from_cell: string | null;
  to_cell: string | null;
  quantity_delta_m: number;
}

export interface MaterialCard {
  sku: MaterialSku;
  total_area_m2: number;
  units: MaterialUnit[];
  plan_fact: MaterialCardPlanFact | null;
  events: MaterialEvent[];
}

export async function getMaterialCard(skuId: number): Promise<MaterialCard> {
  const { data } = await apiClient.get<MaterialCard>(`/material-cards/${skuId}`);
  return data;
}
