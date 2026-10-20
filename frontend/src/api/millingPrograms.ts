import { apiClient } from "./client";

// Справочник программ фрезеровки панелей (07.10).
export interface MillingProgram {
  id: number;
  name: string;
  note: string | null;
  is_active: boolean;
  series: string | null;
  version: string | null;
  width: number | null;
  molding: string | null;
  variant: number | null;
}

export const listMillingPrograms = async (): Promise<MillingProgram[]> => (await apiClient.get<MillingProgram[]>("/milling-programs")).data;
export const addMillingProgram = async (name: string, note?: string): Promise<MillingProgram> =>
  (await apiClient.post<MillingProgram>("/milling-programs", { name, note })).data;
export const patchMillingProgram = async (id: number, p: { note?: string; is_active?: boolean }): Promise<MillingProgram> =>
  (await apiClient.patch<MillingProgram>(`/milling-programs/${id}`, p)).data;

/** Программы, привязанные к изделию вручную (20.10): одна — обе стороны, две — сторона 1 и 2; главнее автоподбора. */
export interface MillingBinding {
  item_id: number;
  item_name: string;
  programs: string[];
}
export const listMillingBindings = async (): Promise<MillingBinding[]> =>
  (await apiClient.get<MillingBinding[]>("/milling-programs/bindings")).data;
export const setMillingBinding = async (itemId: number, programs: string[]): Promise<MillingBinding> =>
  (await apiClient.put<MillingBinding>(`/milling-programs/bindings/${itemId}`, { programs })).data;
