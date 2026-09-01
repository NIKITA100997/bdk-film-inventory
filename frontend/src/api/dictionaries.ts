import { apiClient } from "./client";
import type { MaterialSku } from "./units";
import type { DeleteResult } from "./deletionRequests";

export interface DictEntry {
  id: number;
  name: string;
  is_active: boolean;
  in_use?: boolean;
  sku_count?: number;
}

export interface ThicknessEntry {
  id: number;
  value_mm: number;
  is_active: boolean;
  in_use?: boolean;
  sku_count?: number;
}

// Справочник деталей (раздел про выбор детали в задание) — физическая
// форма детали (ширина/длина/ширина штрипса плёнки), источник подсказки
// для автозаполнения формы, не FK-связь с BOM/заданием.
export interface Part {
  id: number;
  name: string;
  width_mm: number;
  length_m: number;
  strip_width_mm: number | null;
  area: string | null;
  is_active: boolean;
  // Сколько строк активных заданий подтянули новый размер прямо сейчас
  // (см. sync_part_to_task_lines на бэкенде) — только в ответе на save.
  synced_task_lines?: number;
}

export interface PartCreate {
  name: string;
  width_mm: number;
  length_m: number;
  strip_width_mm?: number;
  area?: string | null;
}

export interface PartUpdate {
  name?: string;
  width_mm?: number;
  length_m?: number;
  strip_width_mm?: number;
  area?: string | null;
  is_active?: boolean;
}

export const listParts = async (): Promise<Part[]> => (await apiClient.get<Part[]>("/parts")).data;
export const listAllParts = async (): Promise<Part[]> => (await apiClient.get<Part[]>("/parts/all")).data;
export const listPartDuplicates = async (): Promise<DuplicateCandidate[]> =>
  (await apiClient.get<DuplicateCandidate[]>("/parts/duplicates")).data;
export const createPart = async (payload: PartCreate): Promise<Part> => (await apiClient.post<Part>("/parts", payload)).data;
export const updatePart = async (id: number, payload: PartUpdate): Promise<Part> =>
  (await apiClient.patch<Part>(`/parts/${id}`, payload)).data;

// in_stock_only (раздел про нулевые позиции при выдаче) — сужает до
// позиций, у которых реально есть остаток "На хранении" прямо сейчас.
export const listMaterialSkus = async (inStockOnly = false): Promise<MaterialSku[]> =>
  (await apiClient.get<MaterialSku[]>("/material-skus", { params: { in_stock_only: inStockOnly } })).data;

export interface MaterialSkuCreate {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  supplier_code?: string;
  native_width_mm?: number;
}

export const createMaterialSku = async (payload: MaterialSkuCreate): Promise<MaterialSku> =>
  (await apiClient.post<MaterialSku>("/material-skus", payload)).data;

export const listAllMaterialSkus = async (): Promise<MaterialSku[]> =>
  (await apiClient.get<MaterialSku[]>("/material-skus/all")).data;

export interface MaterialSkuUpdate {
  supplier_code?: string;
  native_width_mm?: number;
  is_active?: boolean;
}

export const updateMaterialSku = async (id: number, payload: MaterialSkuUpdate): Promise<MaterialSku> =>
  (await apiClient.patch<MaterialSku>(`/material-skus/${id}`, payload)).data;

export const deleteMaterialSku = async (id: number): Promise<DeleteResult> =>
  (await apiClient.delete<DeleteResult>(`/material-skus/${id}`)).data;

export const listMaterials = async (): Promise<DictEntry[]> => (await apiClient.get<DictEntry[]>("/materials")).data;
export const listColors = async (): Promise<DictEntry[]> => (await apiClient.get<DictEntry[]>("/colors")).data;
export const listManufacturers = async (): Promise<DictEntry[]> =>
  (await apiClient.get<DictEntry[]>("/manufacturers")).data;
export const listThicknesses = async (): Promise<ThicknessEntry[]> =>
  (await apiClient.get<ThicknessEntry[]>("/thicknesses")).data;
// Сотрудники цеха (раздел про автокомплит вместо голого текста) — не
// учётная запись, только имя для распределения по линиям/дням.
export const listEmployees = async (): Promise<DictEntry[]> => (await apiClient.get<DictEntry[]>("/employees")).data;

export type NameDictKind = "materials" | "colors" | "manufacturers" | "employees";

export interface DuplicateCandidate {
  a_id: number;
  a_name: string;
  b_id: number;
  b_name: string;
  score: number;
}

export const listAllNameDict = async (kind: NameDictKind): Promise<DictEntry[]> =>
  (await apiClient.get<DictEntry[]>(`/${kind}/all`)).data;

export const listNameDictDuplicates = async (kind: NameDictKind): Promise<DuplicateCandidate[]> =>
  (await apiClient.get<DuplicateCandidate[]>(`/${kind}/duplicates`)).data;

export const createNameDictEntry = async (kind: NameDictKind, name: string): Promise<DictEntry> =>
  (await apiClient.post<DictEntry>(`/${kind}`, { name })).data;

export const updateNameDictEntry = async (
  kind: NameDictKind,
  id: number,
  payload: { name?: string; is_active?: boolean },
): Promise<DictEntry> => (await apiClient.patch<DictEntry>(`/${kind}/${id}`, payload)).data;

// Настоящее удаление (не архив) — раздел про чистку неиспользуемых записей
// справочника. Только materials/colors/manufacturers — у "employees" такого
// эндпоинта нет (не FK-справочник, свободный текст в назначениях по дням).
export const deleteNameDictEntry = async (
  kind: Exclude<NameDictKind, "employees">,
  id: number,
): Promise<DeleteResult> => (await apiClient.delete<DeleteResult>(`/${kind}/${id}`)).data;

export const listAllThicknesses = async (): Promise<ThicknessEntry[]> =>
  (await apiClient.get<ThicknessEntry[]>("/thicknesses/all")).data;

export const createThicknessEntry = async (value_mm: number): Promise<ThicknessEntry> =>
  (await apiClient.post<ThicknessEntry>("/thicknesses", { value_mm })).data;

export const updateThicknessEntry = async (
  id: number,
  payload: { value_mm?: number; is_active?: boolean },
): Promise<ThicknessEntry> => (await apiClient.patch<ThicknessEntry>(`/thicknesses/${id}`, payload)).data;

export const deleteThicknessEntry = async (id: number): Promise<DeleteResult> =>
  (await apiClient.delete<DeleteResult>(`/thicknesses/${id}`)).data;

// Аналоги позиций и фото плёнки (8 раздел обратной связи) — ручная привязка
// логистом/админом, признак неликвида считает бэкенд (services/analogs.py).
export interface AnalogEntry {
  link_id: number;
  sku: MaterialSku;
  note: string | null;
  stock_m2: number;
  is_illiquid: boolean;
  stale_days: number | null;
}

export interface SkuWithAnalogs {
  sku: MaterialSku;
  stock_m2: number;
  analogs: AnalogEntry[];
}

export const getSkuAnalogs = async (skuId: number): Promise<SkuWithAnalogs> =>
  (await apiClient.get<SkuWithAnalogs>(`/material-skus/${skuId}/analogs`)).data;

export const addSkuAnalog = async (
  skuId: number,
  payload: { analog_sku_id: number; note?: string },
): Promise<AnalogEntry> => (await apiClient.post<AnalogEntry>(`/material-skus/${skuId}/analogs`, payload)).data;

export const removeSkuAnalog = async (skuId: number, linkId: number): Promise<void> => {
  await apiClient.delete(`/material-skus/${skuId}/analogs/${linkId}`);
};

export const uploadSkuPhoto = async (skuId: number, file: File): Promise<MaterialSku> => {
  const form = new FormData();
  form.append("file", file);
  const { data } = await apiClient.post<MaterialSku>(`/material-skus/${skuId}/photo`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
};

export const deleteSkuPhoto = async (skuId: number): Promise<MaterialSku> =>
  (await apiClient.delete<MaterialSku>(`/material-skus/${skuId}/photo`)).data;

export function skuPhotoUrl(photoPath: string | null): string | null {
  if (!photoPath) return null;
  return `${apiClient.defaults.baseURL}/uploads/${photoPath}`;
}
