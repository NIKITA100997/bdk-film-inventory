import { apiClient } from "./client";

export type ReasonCategory = "warehouse" | "production" | "general";

export interface WriteOffReasonEntry {
  code: string;
  name: string;
  is_active: boolean;
  is_system: boolean;
  category: ReasonCategory;
}

// Активные и не системные — то, что показывают формы списания единицы и
// брака в производстве ("Отход при раскрое" выставляется только системой).
// category — раздел про модуль "Брак и списания": склад просит "warehouse"
// (видит warehouse+general), брак на производстве — "production" (видит
// production+general). Без category — весь список, как раньше.
export async function listWriteOffReasons(category?: ReasonCategory): Promise<WriteOffReasonEntry[]> {
  const { data } = await apiClient.get<WriteOffReasonEntry[]>("/write-off-reasons", { params: { category } });
  return data;
}

// Всё, включая архив и системную — для экрана администрирования.
export async function listAllWriteOffReasons(): Promise<WriteOffReasonEntry[]> {
  const { data } = await apiClient.get<WriteOffReasonEntry[]>("/write-off-reasons/all");
  return data;
}

export async function createWriteOffReason(name: string, category: ReasonCategory = "general"): Promise<WriteOffReasonEntry> {
  const { data } = await apiClient.post<WriteOffReasonEntry>("/write-off-reasons", { name, category });
  return data;
}

export async function updateWriteOffReason(
  code: string,
  payload: { name?: string; is_active?: boolean; category?: ReasonCategory },
): Promise<WriteOffReasonEntry> {
  const { data } = await apiClient.patch<WriteOffReasonEntry>(`/write-off-reasons/${code}`, payload);
  return data;
}
