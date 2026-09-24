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

export interface ManualLinkGroup {
  part_name: string;
  part_id: number;
  linked_part_name: string;
  bom_lines: number;
  task_lines: number;
}

export const listManualLinks = async (): Promise<ManualLinkGroup[]> =>
  (await apiClient.get<ManualLinkGroup[]>("/items/manual-links")).data;

export interface SizeCandidate {
  part_name: string;
  width_mm: number;
  length_m: number;
  strip_width_mm: number | null;
  area: string | null;
  proposed_name: string;
  existing_part_id: number | null;
  bom_lines: number;
  task_lines: number;
  active_task_lines: number;
}

export const listSizeCandidates = async (): Promise<SizeCandidate[]> =>
  (await apiClient.get<SizeCandidate[]>("/items/size-candidates")).data;

export const createSizeParts = async (payload: {
  keys: [string, number, number][];
  route_part_id: number | null;
}): Promise<{ created: number; linked_existing: number; bom_lines: number; task_lines: number }> =>
  (await apiClient.post("/items/size-parts", payload)).data;

export const unlinkLines = async (payload: { part_name: string; part_id: number }): Promise<{ bom_lines: number; task_lines: number }> =>
  (await apiClient.post<{ bom_lines: number; task_lines: number }>("/items/unlink-lines", payload)).data;

export interface TechCard {
  item_id: number;
  name: string;
  kind_code: string;
  kind_name: string;
  source_type: "sku" | "part" | "model" | null;
  source_id: number | null;
  operations: { id: number | null; sequence_order: number; code: string | null; name: string; area: string | null; area_name: string | null }[];
  inputs: {
    name: string;
    part_id: number | null;
    qty_per_unit: number | null;
    unit: string;
    note: string | null;
    // Строка общего состава: компонент, откуда строка (bom / manual / rule) и операция расхода.
    component_item_id: number | null;
    source: "bom" | "manual" | "rule" | null;
    stage_id: number | null;
    operation_name: string | null;
  }[];
  used_in: { name: string; source_type: "model" | "part" | "item"; source_id: number; qty_per_unit: number | null; item_id: number | null }[];
  // Плёнка: группа для складской части карточки.
  material: string | null;
  color: string | null;
  thickness: number | null;
  is_active: boolean;
  type_name: string | null;
}

export const getTechCard = async (itemId: number): Promise<TechCard> =>
  (await apiClient.get<TechCard>(`/items/${itemId}/techcard`)).data;

/** Маршрут любой позиции (единая модель, пункт 3) — правка на месте. */
export const setItemRoute = async (
  itemId: number,
  steps: { code: string; name: string; area: string | null }[],
): Promise<TechCard["operations"]> => (await apiClient.put<TechCard["operations"]>(`/items/${itemId}/route`, steps)).data;

/** Ручной состав позиции (source=manual) целиком. */
export const setItemComponents = async (
  itemId: number,
  rows: { component_item_id: number; qty_per_unit: number; stage_id: number | null }[],
): Promise<TechCard> => (await apiClient.put<TechCard>(`/items/${itemId}/components`, rows)).data;

/** Позиция номенклатуры за деталью / плёнкой / моделью — для перехода в карточку позиции. */
export const lookupItem = async (params: { part_id?: number; sku_id?: number; model_id?: number }): Promise<number> =>
  (await apiClient.get<{ item_id: number }>("/items/lookup", { params })).data.item_id;
