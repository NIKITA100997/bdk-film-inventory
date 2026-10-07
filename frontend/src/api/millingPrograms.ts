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
