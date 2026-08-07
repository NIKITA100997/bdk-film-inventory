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
