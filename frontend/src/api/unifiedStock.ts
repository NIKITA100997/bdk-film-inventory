import { apiClient } from "./client";

// Единые остатки и журнал движений (этап 5 единой модели, слои 1–2) —
// рулоны/штрипсы плёнки и партии п/ф одними строками, только чтение.

export interface Lot {
  kind: "plenka" | "pf";
  lot_id: number;
  item_id: number | null;
  item_name: string;
  qty: number;
  unit: string;
  status: string;
  area: string | null;
  area_name: string | null;
  location_code: string | null;
  stage: string | null;
  detail: string | null;
  area_m2: number | null;
  since: string | null;
  sku_id: number | null;
  part_id: number | null;
}

export interface Movement {
  kind: "plenka" | "pf";
  at: string;
  event: string;
  lot_id: number;
  item_id: number | null;
  item_name: string;
  qty_delta: number | null;
  unit: string;
  area_name: string | null;
  from_place: string | null;
  to_place: string | null;
  user_name: string | null;
  note: string | null;
}

export const listLots = async (params: {
  kind?: string;
  item_id?: number;
  area?: string;
  include_written_off?: boolean;
}): Promise<Lot[]> => (await apiClient.get<Lot[]>("/unified-stock/lots", { params })).data;

export const listMovements = async (params: {
  kind?: string;
  item_id?: number;
  date_from?: string;
  date_to?: string;
  limit?: number;
}): Promise<Movement[]> => (await apiClient.get<Movement[]>("/unified-stock/movements", { params })).data;

export const KIND_LABEL: Record<string, string> = { plenka: "Плёнка", pf: "П/ф" };
