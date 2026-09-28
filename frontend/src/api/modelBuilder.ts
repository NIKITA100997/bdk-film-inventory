import { apiClient } from "./client";
import type { PropertyValue } from "./itemTypes";

// Конструктор моделей: подсказки по типу, новая модель, варианты пачкой,
// дерево техкарты для схемы (backend/app/services/model_builder.py).

export interface Hint {
  value: PropertyValue;
  count: number;
}

export interface TypeHints {
  /** property_id → частые значения у вариантов (у списка — id варианта). */
  properties: Record<number, Hint[]>;
  /** property_id → код параметра серии → частые значения. */
  option_fields: Record<number, Record<string, Hint[]>>;
}

export const getTypeHints = async (typeId: number): Promise<TypeHints> =>
  (await apiClient.get<TypeHints>(`/item-types/${typeId}/hints`)).data;

export const createModel = async (
  typeId: number,
  payload: { value: string; params: Record<string, number | string | null> },
): Promise<{ option_id: number; model_item_id: number; name: string }> =>
  (await apiClient.post(`/item-types/${typeId}/models`, payload)).data;

export type VariantStatus = "new" | "exists" | "error" | "created";

export interface VariantRow {
  values: Record<number, PropertyValue>;
  name: string | null;
  status: VariantStatus;
  item_id: number | null;
  errors: string[];
}

export interface VariantsResult {
  rows: VariantRow[];
  total: number;
  truncated: boolean;
}

/** Все сочетания выбранных значений: create=false — предпросмотр. */
export const variantsBatch = async (
  typeId: number,
  choices: Record<number, PropertyValue[]>,
  create: boolean,
): Promise<VariantsResult> => (await apiClient.post(`/item-types/${typeId}/variants`, { choices, create })).data;

export interface TreeOperation {
  name: string;
  area: string | null;
  area_name: string | null;
  components: TreeNode[];
}

export interface TreeNode {
  name: string;
  kind_code: string | null;
  item_id: number | null;
  exists: boolean;
  qty: number | null;
  unit: string | null;
  operations: TreeOperation[];
  loose: TreeNode[];
  warnings: string[];
  /** Закреплённая плёнка детали (панели), если есть. */
  film?: string | null;
}

export const getItemTree = async (itemId: number): Promise<TreeNode> =>
  (await apiClient.get<TreeNode>(`/items/${itemId}/tree`)).data;

export const previewTree = async (typeId: number, values: Record<number, PropertyValue>): Promise<TreeNode> =>
  (await apiClient.post<TreeNode>(`/item-types/${typeId}/tree`, { values })).data;

export interface VariantStat {
  item_id: number;
  name: string;
  is_active: boolean;
  /** свойство → значение подписью */
  values: Record<string, string>;
  ordered: number;
  done: number;
  defect: number;
  in_work: number;
  draft: number;
  orders: number;
  last_order_at: string | null;
}

export interface ModelSummary {
  model_id: number;
  variants: VariantStat[];
  totals: Record<"variants" | "ordered" | "done" | "defect" | "in_work" | "draft" | "orders", number>;
  by_property: Record<string, { value: string; variants: number; ordered: number }[]>;
  order_ids: number[];
}

export const getModelSummary = async (modelId: number): Promise<ModelSummary> =>
  (await apiClient.get<ModelSummary>(`/items/${modelId}/model-summary`)).data;
