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
  group_id: number | null;
  /** Модель (серия) — варианты ссылаются на неё через model_id. */
  is_model: boolean;
  model_id: number | null;
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

/** Группа номенклатуры — папка, как в 1С (вложенная, внутри вида). */
export interface ItemGroup {
  id: number;
  kind_code: string;
  parent_id: number | null;
  name: string;
  sort_order: number;
  items: number;
}

export const listItemGroups = async (): Promise<ItemGroup[]> => (await apiClient.get<ItemGroup[]>("/item-groups")).data;
export const createItemGroup = async (payload: { kind_code: string; parent_id: number | null; name: string }): Promise<ItemGroup> =>
  (await apiClient.post<ItemGroup>("/item-groups", payload)).data;
export const updateItemGroup = async (id: number, payload: { parent_id: number | null; name: string; sort_order: number }): Promise<ItemGroup> =>
  (await apiClient.put<ItemGroup>(`/item-groups/${id}`, payload)).data;
export const deleteItemGroup = async (id: number): Promise<void> => {
  await apiClient.delete(`/item-groups/${id}`);
};
export const setItemsGroup = async (payload: { item_ids: number[]; group_id: number | null }): Promise<{ moved: number }> =>
  (await apiClient.post<{ moved: number }>("/items/set-group", payload)).data;

/** Путь группы «МК / Стоевые» и все её потомки (для отбора с подгруппами). */
export function groupPath(groups: ItemGroup[], id: number | null): string {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parts: string[] = [];
  for (let g = id != null ? byId.get(id) : undefined; g; g = g.parent_id != null ? byId.get(g.parent_id) : undefined) parts.unshift(g.name);
  return parts.join(" / ");
}

export function groupWithDescendants(groups: ItemGroup[], id: number): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parent_id != null && out.has(g.parent_id) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Дерево групп вида для TreeSelect. */
export function groupTree(groups: ItemGroup[], kind: string, parent: number | null = null): { value: number; title: string; children: ReturnType<typeof groupTree> }[] {
  return groups
    .filter((g) => g.kind_code === kind && g.parent_id === parent)
    .map((g) => ({ value: g.id, title: g.name, children: groupTree(groups, kind, g.id) }));
}

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
  type_id: number | null;
  is_model: boolean;
  model_id: number | null;
  model_name: string | null;
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
/** Права, с которыми открываются номенклатура и карточка позиции (просмотр). */
export const ITEM_VIEW_PERMISSIONS = [
  "materials.manage",
  "production_tasks.manage",
  "production_tasks.view",
  "part_units.manage",
  "part_units.view",
  "units.receive",
  "units.issue",
  "units.return",
];

export const lookupItem = async (params: {
  part_id?: number;
  sku_id?: number;
  model_id?: number;
  material?: string;
  color?: string;
  thickness?: number;
}): Promise<number> =>
  (await apiClient.get<{ item_id: number }>("/items/lookup", { params })).data.item_id;
