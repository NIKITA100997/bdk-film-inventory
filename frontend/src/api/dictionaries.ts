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
