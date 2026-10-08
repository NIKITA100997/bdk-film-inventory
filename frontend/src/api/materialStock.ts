import { apiClient } from "./client";

// Материалы (вид «Материал»: МДФ, пенопласт, клей, кромка…) — остаток
// одним числом на склад, движения (backend/app/api/materials.py).

export interface MaterialStockRow {
  item_id: number;
  name: string;
  unit: string;
  group_id: number | null;
  group_name: string | null;
  is_active: boolean;
  balance: number;
  last_move_at: string | null;
  /** норматив (08.10): ниже — пора пополнять */
  min_stock?: number | null;
  /** средняя цена остатка, ₽ за единицу, и стоимость остатка (08.10) */
  avg_price_rub?: number | null;
  value_rub?: number | null;
}

/** Потребность и пополнение материала (08.10) — те же нормативы, что у
 * плёнки и п/ф. */
export interface MaterialDemandRow {
  item_id: number;
  name: string;
  unit: string;
  group_name: string | null;
  stock: number;
  demand: number;
  sources: { task_id: number; task_name: string; order_id: number | null; qty: number }[];
  min_stock: number | null;
  min_batch: number | null;
  batch_multiple: number | null;
  need: number;
  shortage: number;
  to_order: number;
}

export const listMaterialDemand = async (): Promise<MaterialDemandRow[]> =>
  (await apiClient.get<MaterialDemandRow[]>("/material-stock/demand")).data;

export type MaterialMoveKind = "receipt" | "consumption" | "writeoff" | "adjust";

export const MOVE_KIND_LABEL: Record<MaterialMoveKind, string> = {
  receipt: "Приход",
  consumption: "Расход в производство",
  writeoff: "Списание",
  adjust: "Инвентаризация",
};

export interface MaterialMove {
  id: number;
  item_id: number;
  item_name: string;
  unit: string;
  kind: MaterialMoveKind;
  qty: number;
  doc: string | null;
  note: string | null;
  task_id: number | null;
  user_name: string;
  occurred_at: string;
  /** цена единицы и сумма движения, ₽ (08.10) */
  price_rub?: number | null;
  amount_rub?: number | null;
}

export const listMaterialStock = async (includeInactive = false): Promise<MaterialStockRow[]> =>
  (await apiClient.get<MaterialStockRow[]>("/material-stock", { params: { include_inactive: includeInactive } })).data;

export const createMaterial = async (payload: { name: string; unit?: string | null }): Promise<MaterialStockRow> =>
  (await apiClient.post<MaterialStockRow>("/material-stock", payload)).data;

export const updateMaterial = async (
  itemId: number,
  payload: { name?: string; unit?: string; is_active?: boolean },
): Promise<MaterialStockRow> => (await apiClient.patch<MaterialStockRow>(`/material-stock/${itemId}`, payload)).data;

export const createMaterialMove = async (payload: {
  item_id: number;
  kind: Exclude<MaterialMoveKind, "consumption">;
  qty: number;
  doc?: string | null;
  note?: string | null;
  occurred_at?: string | null;
  /** Цена прихода по УПД — за единицу позиции, в валюте. */
  price?: number | null;
  price_currency?: string;
}): Promise<MaterialMove> => (await apiClient.post<MaterialMove>("/material-stock/moves", payload)).data;

export const listMaterialMoves = async (params: {
  item_id?: number;
  date_from?: string;
  date_to?: string;
}): Promise<MaterialMove[]> => (await apiClient.get<MaterialMove[]>("/material-stock/moves", { params })).data;
