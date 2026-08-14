import { apiClient } from "./client";

// Общий ответ "умных" DELETE-эндпоинтов (раздел про удаление сущностей)
// — суперпользователь удаляет сразу (deleted=true), у остальных вместо
// этого создаётся заявка на удаление (requested=true), сущность цела.
export interface DeleteResult {
  deleted: boolean;
  requested: boolean;
}

export type DeletionEntityType = "production_task" | "supplier_order" | "purchase_request" | "material_sku" | "material_unit";

export const ENTITY_TYPE_LABELS: Record<DeletionEntityType, string> = {
  production_task: "Задание",
  supplier_order: "Заказ поставщику",
  purchase_request: "Заявка поставщику",
  material_sku: "Позиция номенклатуры",
  material_unit: "Физическая единица",
};

export interface DeletionRequest {
  id: number;
  entity_type: DeletionEntityType;
  entity_id: number;
  entity_label: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  requested_by: number;
  requested_by_name: string;
  created_at: string;
  resolved_by: number | null;
  resolved_at: string | null;
  resolution_note: string | null;
}

export async function listDeletionRequests(statusFilter?: string): Promise<DeletionRequest[]> {
  const { data } = await apiClient.get<DeletionRequest[]>("/deletion-requests", {
    params: statusFilter ? { status_filter: statusFilter } : undefined,
  });
  return data;
}

export async function approveDeletionRequest(id: number): Promise<DeletionRequest> {
  const { data } = await apiClient.post<DeletionRequest>(`/deletion-requests/${id}/approve`);
  return data;
}

export async function rejectDeletionRequest(id: number, note?: string): Promise<DeletionRequest> {
  const { data } = await apiClient.post<DeletionRequest>(`/deletion-requests/${id}/reject`, { note });
  return data;
}
