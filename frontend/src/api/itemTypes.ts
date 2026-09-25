import { apiClient } from "./client";

// Единая модель, пункты 1–2: тип изделия внутри вида номенклатуры и его
// свойства (характеристики). У свойства-списка варианты со своими
// параметрами (серия → толщина каркаса, кромка).

export type PropertyValueType = "number" | "text" | "bool" | "list";

export interface OptionField {
  code: string;
  name: string;
  value_type: "number" | "text";
}

export interface PropertyOption {
  id: number;
  value: string;
  params: Record<string, number | string | null>;
  is_active: boolean;
  used: number;
}

export interface ItemProperty {
  id: number;
  code: string;
  name: string;
  value_type: PropertyValueType;
  unit: string | null;
  is_required: boolean;
  sort_order: number;
  option_fields: OptionField[];
  options: PropertyOption[];
  used: number;
}

export interface TypeOperation {
  name: string;
  /** null — «общий запас»: последняя операция без участка, партии берутся с любого. */
  area: string | null;
  condition: string | null;
}

export interface TypeComponentRule {
  name_template: string;
  qty_expr: string;
  condition: string | null;
  width_expr: string | null;
  length_expr: string | null;
  strip_width_expr: string | null;
  route_part_id: number | null;
  operation_name: string | null;
  // Компонент со своим типом (вида «П/ф») и формулы его свойств от свойств родителя.
  component_type_id: number | null;
  component_values: Record<string, string>;
}

export interface ItemType {
  id: number;
  kind_code: string;
  kind_name: string;
  name: string;
  is_active: boolean;
  item_count: number;
  // Правила типа (пункт 3): шаблон названия позиции, операции с условиями, правила состава.
  name_template: string | null;
  properties: ItemProperty[];
  operations: TypeOperation[];
  component_rules: TypeComponentRule[];
}

export interface PropertyInput {
  name: string;
  code?: string | null;
  value_type: PropertyValueType;
  unit?: string | null;
  is_required: boolean;
  option_fields: OptionField[];
}

export type PropertyValue = number | string | boolean | null;

export const PROPERTY_TYPE_LABEL: Record<PropertyValueType, string> = {
  number: "Число",
  text: "Текст",
  bool: "Да/нет",
  list: "Список",
};

export const listItemTypes = async (kind?: string): Promise<ItemType[]> =>
  (await apiClient.get<ItemType[]>("/item-types", { params: kind ? { kind } : {} })).data;

export const createItemType = async (payload: { kind_code: string; name: string }): Promise<ItemType> =>
  (await apiClient.post<ItemType>("/item-types", payload)).data;

export const updateItemType = async (
  id: number,
  payload: { name?: string; is_active?: boolean; name_template?: string },
): Promise<ItemType> =>
  (await apiClient.put<ItemType>(`/item-types/${id}`, payload)).data;

export const deleteItemType = async (id: number): Promise<void> => {
  await apiClient.delete(`/item-types/${id}`);
};

export const createProperty = async (typeId: number, payload: PropertyInput): Promise<ItemProperty> =>
  (await apiClient.post<ItemProperty>(`/item-types/${typeId}/properties`, payload)).data;

export const updateProperty = async (id: number, payload: PropertyInput): Promise<ItemProperty> =>
  (await apiClient.put<ItemProperty>(`/item-properties/${id}`, payload)).data;

export const deleteProperty = async (id: number): Promise<void> => {
  await apiClient.delete(`/item-properties/${id}`);
};

export const replacePropertyOptions = async (
  id: number,
  options: { id?: number | null; value: string; params: Record<string, number | string | null>; is_active: boolean }[],
): Promise<ItemProperty> => (await apiClient.put<ItemProperty>(`/item-properties/${id}/options`, options)).data;

export interface ItemPropertiesState {
  item_id: number;
  kind_code: string;
  type_id: number | null;
  values: Record<string, PropertyValue>;
  // Свойства сохранены, но правила типа не применились (не хватает данных).
  rules_errors?: string[];
}

export const getItemProperties = async (itemId: number): Promise<ItemPropertiesState> =>
  (await apiClient.get<ItemPropertiesState>(`/items/${itemId}/properties`)).data;

export const setItemProperties = async (
  itemId: number,
  payload: { type_id: number | null; values: Record<string, PropertyValue> },
): Promise<ItemPropertiesState> => (await apiClient.put<ItemPropertiesState>(`/items/${itemId}/properties`, payload)).data;

export const setTypeOperations = async (typeId: number, ops: TypeOperation[]): Promise<ItemType> =>
  (await apiClient.put<ItemType>(`/item-types/${typeId}/operations`, ops)).data;

export const setTypeComponentRules = async (typeId: number, rules: TypeComponentRule[]): Promise<ItemType> =>
  (await apiClient.put<ItemType>(`/item-types/${typeId}/component-rules`, rules)).data;

export interface RulesPreview {
  name: string | null;
  operations: TypeOperation[];
  components: {
    name: string;
    qty: number;
    width_mm: number | null;
    length_mm: number | null;
    strip_width_mm: number | null;
    operation_name: string | null;
    exists: boolean;
  }[];
  errors: string[];
}

export const previewTypeRules = async (
  typeId: number,
  payload: { item_id?: number; values?: Record<string, PropertyValue> },
): Promise<RulesPreview> => (await apiClient.post<RulesPreview>(`/item-types/${typeId}/preview`, payload)).data;

export const applyTypeRules = async (typeId: number): Promise<{ applied: number; errors: Record<string, string[]> }> =>
  (await apiClient.post(`/item-types/${typeId}/apply`)).data;

export const createItemByType = async (
  typeId: number,
  values: Record<string, PropertyValue>,
): Promise<{ item_id: number; name: string; created: boolean }> =>
  (await apiClient.post("/items/by-type", { type_id: typeId, values })).data;
