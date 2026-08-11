import { apiClient } from "./client";
import type { MaterialSku } from "./units";

export interface DictEntry {
  id: number;
  name: string;
  is_active: boolean;
}

export interface ThicknessEntry {
  id: number;
  value_mm: number;
  is_active: boolean;
}

export const listMaterialSkus = async (): Promise<MaterialSku[]> =>
  (await apiClient.get<MaterialSku[]>("/material-skus")).data;

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

export const listMaterials = async (): Promise<DictEntry[]> => (await apiClient.get<DictEntry[]>("/materials")).data;
export const listColors = async (): Promise<DictEntry[]> => (await apiClient.get<DictEntry[]>("/colors")).data;
export const listManufacturers = async (): Promise<DictEntry[]> =>
  (await apiClient.get<DictEntry[]>("/manufacturers")).data;
export const listThicknesses = async (): Promise<ThicknessEntry[]> =>
  (await apiClient.get<ThicknessEntry[]>("/thicknesses")).data;

export type NameDictKind = "materials" | "colors" | "manufacturers";

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

export const updateNameDictEntry = async (
  kind: NameDictKind,
  id: number,
  payload: { name?: string; is_active?: boolean },
): Promise<DictEntry> => (await apiClient.patch<DictEntry>(`/${kind}/${id}`, payload)).data;

export const listAllThicknesses = async (): Promise<ThicknessEntry[]> =>
  (await apiClient.get<ThicknessEntry[]>("/thicknesses/all")).data;

export const updateThicknessEntry = async (
  id: number,
  payload: { value_mm?: number; is_active?: boolean },
): Promise<ThicknessEntry> => (await apiClient.patch<ThicknessEntry>(`/thicknesses/${id}`, payload)).data;

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
