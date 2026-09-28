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
}

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
}): Promise<MaterialMove> => (await apiClient.post<MaterialMove>("/material-stock/moves", payload)).data;

export const listMaterialMoves = async (params: {
  item_id?: number;
  date_from?: string;
  date_to?: string;
}): Promise<MaterialMove[]> => (await apiClient.get<MaterialMove[]>("/material-stock/moves", { params })).data;
