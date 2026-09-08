import { apiClient } from "./client";

// Раздел про аналоги ширин при выдаче — группы взаимозаменяемых ширин
// штрипса плёнки (290/285/287мм и т.п.), не привязаны к конкретному
// материалу/детали, заводятся вручную (DictionaryAdmin.tsx).
export interface WidthAnalogGroup {
  id: number;
  note: string | null;
  members: { width_mm: number }[];
}

export const listWidthAnalogGroups = async (): Promise<WidthAnalogGroup[]> =>
  (await apiClient.get<WidthAnalogGroup[]>("/width-analogs")).data;

export const createWidthAnalogGroup = async (widths: number[], note?: string): Promise<WidthAnalogGroup> =>
  (await apiClient.post<WidthAnalogGroup>("/width-analogs", { widths, note })).data;

export const updateWidthAnalogGroup = async (id: number, widths: number[], note?: string): Promise<WidthAnalogGroup> =>
  (await apiClient.patch<WidthAnalogGroup>(`/width-analogs/${id}`, { widths, note })).data;

export const deleteWidthAnalogGroup = async (id: number): Promise<void> => {
  await apiClient.delete(`/width-analogs/${id}`);
};

// Раздел про ручной подбор донора (Issue.tsx) — визуальная консистентность
// с бэкендом: если сервер примет аналог как совпадение, список должен
// подсвечивать его так же, не только точное число.
export function isWidthMatch(groups: WidthAnalogGroup[], a: number, b: number): boolean {
  if (a === b) return true;
  const group = groups.find((g) => g.members.some((m) => m.width_mm === a));
  return !!group && group.members.some((m) => m.width_mm === b);
}
