import { apiClient } from "./client";

export interface ItemKind {
  id: number;
  code: string;
  name: string;
  unit: string;
  lot_tracking: boolean;
}

export interface Item {
  id: number;
  kind_code: string;
  kind_name: string;
  unit: string;
  name: string;
  code_1c: string | null;
  is_active: boolean;
  source_type: "sku" | "part" | "model" | null;
  source_id: number | null;
  material: string | null;
  color: string | null;
  thickness: number | null;
}

export interface UnlinkedLineGroup {
  part_name: string;
  bom_lines: number;
  task_lines: number;
  active_task_lines: number;
  suggestions: { part_id: number; part_name: string; score: number }[];
}

export const listItemKinds = async (): Promise<ItemKind[]> => (await apiClient.get<ItemKind[]>("/item-kinds")).data;

export const listItems = async (params: { kind?: string; q?: string; include_inactive?: boolean }): Promise<Item[]> =>
  (await apiClient.get<Item[]>("/items", { params })).data;

export const listUnlinkedLines = async (): Promise<UnlinkedLineGroup[]> =>
  (await apiClient.get<UnlinkedLineGroup[]>("/items/unlinked-lines")).data;

export const linkLines = async (payload: { part_name: string; part_id: number }): Promise<{ bom_lines: number; task_lines: number }> =>
  (await apiClient.post<{ bom_lines: number; task_lines: number }>("/items/link-lines", payload)).data;
