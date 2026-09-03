import { apiClient } from "./client";
import type { MaterialSku, MaterialUnit } from "./units";

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
  events: MaterialEvent[];
}

export async function getMaterialCard(skuId: number): Promise<MaterialCard> {
  const { data } = await apiClient.get<MaterialCard>(`/material-cards/${skuId}`);
  return data;
}

// Раздел про производителя внутри карточки материала (не отдельным
// измерением) — карточка теперь по группе материал+цвет+толщина, skus —
// все производители этой группы сразу (каждый со своими код-у-поставщика/
// родная-ширина/фото/аналоги).
export interface MaterialCardGroup {
  material: string;
  color: string;
  thickness: number;
  skus: MaterialSku[];
  total_area_m2: number;
  units: MaterialUnit[];
  events: MaterialEvent[];
}

export async function getMaterialCardByGroup(material: string, color: string, thickness: number): Promise<MaterialCardGroup> {
  const { data } = await apiClient.get<MaterialCardGroup>("/material-cards/by-group", { params: { material, color, thickness } });
  return data;
}
