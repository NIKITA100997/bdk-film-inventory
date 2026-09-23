import { apiClient } from "./client";

export interface AreaTaskLine {
  id: number;
  sort_order: number;
  name: string;
  quantity_pieces: number;
  part_stage_id: number | null;
  part_id: number | null;
  part_name: string | null;
  stage_name: string | null;
  note: string | null;
  good_pieces: number;
  defect_pieces: number;
  remaining_pieces: number;
}

export interface AreaTask {
  id: number;
  area: string;
  name: string;
  source: string;
  ship_date: string | null;
  note: string | null;
  is_active: boolean;
  created_by: number;
  created_at: string;
  lines: AreaTaskLine[];
}

export interface AreaTaskLineCreate {
  name: string;
  quantity_pieces: number;
  part_stage_id?: number | null;
  note?: string | null;
}

export interface AreaTaskCreate {
  area: string;
  name: string;
  ship_date?: string | null;
  note?: string | null;
  lines: AreaTaskLineCreate[];
}

export interface AreaTaskReport {
  id: number;
  good_pieces: number;
  defect_pieces: number;
  defect_reason: string | null;
  note: string | null;
  reported_by: number;
  reported_by_name: string;
  occurred_at: string;
}

export interface AreaTaskReportCreate {
  good_pieces: number;
  defect_pieces: number;
  defect_reason?: string | null;
  note?: string | null;
  occurred_at?: string | null;
}

export interface AreaPartStage {
  part_stage_id: number;
  part_id: number;
  part_name: string;
  stage_name: string;
  is_first: boolean;
}

export const listAreaTasks = async (params: { area?: string; include_closed?: boolean }): Promise<AreaTask[]> =>
  (await apiClient.get<AreaTask[]>("/area-tasks", { params })).data;

export const listAreaPartStages = async (area: string): Promise<AreaPartStage[]> =>
  (await apiClient.get<AreaPartStage[]>("/area-tasks/part-stages", { params: { area } })).data;

export const createAreaTask = async (payload: AreaTaskCreate): Promise<AreaTask> =>
  (await apiClient.post<AreaTask>("/area-tasks", payload)).data;

export const updateAreaTask = async (
  id: number,
  payload: { name?: string; ship_date?: string | null; note?: string | null; is_active?: boolean },
): Promise<AreaTask> => (await apiClient.patch<AreaTask>(`/area-tasks/${id}`, payload)).data;

export const listAreaTaskReports = async (taskId: number, lineId: number): Promise<AreaTaskReport[]> =>
  (await apiClient.get<AreaTaskReport[]>(`/area-tasks/${taskId}/lines/${lineId}/reports`)).data;

export const createAreaTaskReport = async (
  taskId: number,
  lineId: number,
  payload: AreaTaskReportCreate,
): Promise<AreaTaskReport> =>
  (await apiClient.post<AreaTaskReport>(`/area-tasks/${taskId}/lines/${lineId}/reports`, payload)).data;
