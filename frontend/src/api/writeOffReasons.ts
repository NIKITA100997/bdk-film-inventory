import { apiClient } from "./client";

export interface WriteOffReasonEntry {
  code: string;
  name: string;
  is_active: boolean;
  is_system: boolean;
}

// Активные и не системные — то, что показывают формы списания единицы и
// брака в производстве ("Отход при раскрое" выставляется только системой).
export async function listWriteOffReasons(): Promise<WriteOffReasonEntry[]> {
  const { data } = await apiClient.get<WriteOffReasonEntry[]>("/write-off-reasons");
  return data;
}

// Всё, включая архив и системную — для экрана администрирования.
export async function listAllWriteOffReasons(): Promise<WriteOffReasonEntry[]> {
  const { data } = await apiClient.get<WriteOffReasonEntry[]>("/write-off-reasons/all");
  return data;
}

export async function createWriteOffReason(name: string): Promise<WriteOffReasonEntry> {
  const { data } = await apiClient.post<WriteOffReasonEntry>("/write-off-reasons", { name });
  return data;
}

export async function updateWriteOffReason(
  code: string,
  payload: { name?: string; is_active?: boolean },
): Promise<WriteOffReasonEntry> {
  const { data } = await apiClient.patch<WriteOffReasonEntry>(`/write-off-reasons/${code}`, payload);
  return data;
}
