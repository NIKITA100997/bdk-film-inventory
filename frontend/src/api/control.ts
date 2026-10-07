import { apiClient } from "./client";

// Закрытие периода и запросы администратору (07.10).

export interface PeriodRow {
  id: number;
  closed_until: string | null;
  action: "close" | "reopen";
  reason: string | null;
  user_name: string | null;
  created_at: string;
}

export interface PeriodState {
  closed_until: string | null;
  history: PeriodRow[];
}

export interface ActionRequest {
  id: number;
  method: string;
  path: string;
  summary: string;
  error: string | null;
  kind: "forbidden" | "period_closed";
  page: string | null;
  comment: string;
  status: "pending" | "executing" | "done" | "failed" | "rejected";
  requested_by_name: string | null;
  created_at: string;
  resolved_by_name: string | null;
  resolved_at: string | null;
  result: string | null;
  mine: boolean;
}

export interface ActionRequestsSummary {
  to_approve: number;
  mine_resolved: number;
  can_approve: boolean;
}

export const getPeriod = async (): Promise<PeriodState> => (await apiClient.get<PeriodState>("/period-closing")).data;
export const closePeriod = async (until: string, reason?: string): Promise<PeriodState> =>
  (await apiClient.post<PeriodState>("/period-closing/close", { until, reason })).data;
export const reopenPeriod = async (until: string | null, reason: string): Promise<PeriodState> =>
  (await apiClient.post<PeriodState>("/period-closing/reopen", { until, reason })).data;

export const createActionRequest = async (p: {
  method: string;
  path: string;
  body: unknown;
  error: string | null;
  kind: "forbidden" | "period_closed";
  page: string;
  comment: string;
}): Promise<ActionRequest> => (await apiClient.post<ActionRequest>("/action-requests", p)).data;
export const listActionRequests = async (scope: "mine" | "pending" | "all"): Promise<ActionRequest[]> =>
  (await apiClient.get<ActionRequest[]>("/action-requests", { params: { scope } })).data;
export const actionRequestsSummary = async (): Promise<ActionRequestsSummary> =>
  (await apiClient.get<ActionRequestsSummary>("/action-requests/summary")).data;
export const approveActionRequest = async (id: number): Promise<ActionRequest> =>
  (await apiClient.post<ActionRequest>(`/action-requests/${id}/approve`)).data;
export const rejectActionRequest = async (id: number, reason: string): Promise<ActionRequest> =>
  (await apiClient.post<ActionRequest>(`/action-requests/${id}/reject`, { reason })).data;

export const REQUEST_STATUS: Record<ActionRequest["status"], { label: string; color: string }> = {
  pending: { label: "ждёт решения", color: "gold" },
  executing: { label: "выполняется", color: "blue" },
  done: { label: "выполнено", color: "green" },
  failed: { label: "не выполнено", color: "red" },
  rejected: { label: "отклонено", color: "default" },
};
