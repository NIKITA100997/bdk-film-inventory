import { apiClient } from "./client";

// Пересчёт п/ф на участке (инвентаризация п/ф, 06.10): п/ф лежат на участках
// без бирок — участок пересчитывают по партиям, расхождения решают после закрытия.

export type CountDecision = "write_off" | "accept" | "keep";

export interface PartCountLine {
  id: number;
  part_unit_id: number | null;
  part_id: number;
  part_name: string;
  item_id: number | null;
  group_name: string | null;
  stage_id: number;
  stage_name: string;
  manufactured_at: string | null;
  location_code: string | null;
  expected_qty: number;
  counted_qty: number | null;
  diff: number | null;
  decision: CountDecision | null;
  allowed: CountDecision[];
  reason: string | null;
  note: string | null;
  result_part_unit_id: number | null;
}

export interface PartCountSession {
  id: number;
  area: string;
  area_name: string;
  scope: { group_ids?: number[]; stages?: string[] } | null;
  status: "in_progress" | "closed";
  note: string | null;
  started_by: number;
  started_at: string;
  closed_at: string | null;
  lines_total: number;
  lines_counted: number;
  lines_diff: number;
  lines_open: number;
}

export interface PartCountDetail extends PartCountSession {
  lines: PartCountLine[];
}

export interface AreaPart {
  part_id: number;
  part_name: string;
  stage_name: string;
}

export const listPartCounts = async (): Promise<PartCountSession[]> => (await apiClient.get<PartCountSession[]>("/part-counts")).data;

export const startPartCount = async (payload: {
  area: string;
  scope: { group_ids: number[]; stages: string[] };
  note?: string | null;
}): Promise<PartCountDetail> => (await apiClient.post<PartCountDetail>("/part-counts", payload)).data;

export const getPartCount = async (id: number): Promise<PartCountDetail> => (await apiClient.get<PartCountDetail>(`/part-counts/${id}`)).data;

export const setPartCountLine = async (id: number, lineId: number, counted: number | null): Promise<PartCountDetail> =>
  (await apiClient.put<PartCountDetail>(`/part-counts/${id}/lines/${lineId}`, { counted_qty: counted })).data;

export const addPartCountExtra = async (id: number, partId: number, counted: number): Promise<PartCountDetail> =>
  (await apiClient.post<PartCountDetail>(`/part-counts/${id}/lines`, { part_id: partId, counted_qty: counted })).data;

export const removePartCountExtra = async (id: number, lineId: number): Promise<PartCountDetail> =>
  (await apiClient.delete<PartCountDetail>(`/part-counts/${id}/lines/${lineId}`)).data;

export const closePartCount = async (id: number): Promise<PartCountDetail> =>
  (await apiClient.post<PartCountDetail>(`/part-counts/${id}/close`)).data;

export const cancelPartCount = async (id: number): Promise<void> => {
  await apiClient.delete(`/part-counts/${id}`);
};

export const resolvePartCountLine = async (
  id: number,
  lineId: number,
  payload: { decision: CountDecision; reason?: string; note?: string },
): Promise<PartCountDetail> => (await apiClient.post<PartCountDetail>(`/part-counts/${id}/lines/${lineId}/resolve`, payload)).data;

export const listAreaParts = async (area: string): Promise<AreaPart[]> =>
  (await apiClient.get<AreaPart[]>(`/part-counts/area-parts/${encodeURIComponent(area)}`)).data;
