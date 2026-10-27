import { apiClient } from "./client";

// Инвентаризация по месту (27.10; до того — пересчёт п/ф на участке, 06.10):
// место — участок, склад плёнки, склад материалов или склад ГП площадки; в
// листе — всё, что там по учёту (плёнка по рулонам, п/ф по партиям, материалы
// и изделия по позиции); расхождения решают после закрытия.

export type CountDecision = "write_off" | "accept" | "keep";
export type CountKind = "plenka" | "pf" | "material" | "fg";
export type PlaceType = "area" | "warehouse" | "materials" | "fg";

export const COUNT_KIND_LABEL: Record<CountKind, string> = {
  plenka: "Плёнка",
  pf: "П/ф",
  material: "Материалы",
  fg: "Изделия",
};

export interface PartCountLine {
  id: number;
  kind: CountKind;
  name: string;
  unit: string;
  detail: string | null;
  lot: string | null;
  part_unit_id: number | null;
  material_unit_id: number | null;
  part_id: number | null;
  item_id: number | null;
  group_name: string | null;
  stage_id: number | null;
  stage_name: string | null;
  manufactured_at: string | null;
  location_code: string | null;
  /** плёнка, найденная здесь, а по учёту — в другом месте */
  elsewhere: string | null;
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
  place_type: PlaceType;
  place_ref: string | null;
  place_name: string;
  area: string | null;
  area_name: string;
  kinds: CountKind[];
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

export interface CountPlace {
  place_type: PlaceType;
  place_ref: string | null;
  name: string;
  group: string;
  kinds: CountKind[];
}

export interface AreaPart {
  part_id: number;
  part_name: string;
  stage_name: string;
}

export const listCountPlaces = async (): Promise<CountPlace[]> => (await apiClient.get<CountPlace[]>("/part-counts/places")).data;

export const listPartCounts = async (): Promise<PartCountSession[]> => (await apiClient.get<PartCountSession[]>("/part-counts")).data;

export const startPartCount = async (payload: {
  place_type: PlaceType;
  place_ref: string | null;
  scope: { group_ids: number[]; stages: string[] };
  note?: string | null;
}): Promise<PartCountDetail> => (await apiClient.post<PartCountDetail>("/part-counts", payload)).data;

export const getPartCount = async (id: number): Promise<PartCountDetail> => (await apiClient.get<PartCountDetail>(`/part-counts/${id}`)).data;

export const setPartCountLine = async (id: number, lineId: number, counted: number | null): Promise<PartCountDetail> =>
  (await apiClient.put<PartCountDetail>(`/part-counts/${id}/lines/${lineId}`, { counted_qty: counted })).data;

/** Найдено сверх листа: п/ф — деталь, материал/изделие — позиция, плёнка — рулон по номеру бирки. */
export const addPartCountExtra = async (
  id: number,
  payload: { kind: CountKind; part_id?: number; item_id?: number; material_unit_id?: number; counted_qty?: number | null },
): Promise<PartCountDetail> => (await apiClient.post<PartCountDetail>(`/part-counts/${id}/lines`, payload)).data;

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

/** Одно решение по многим строкам — всё или ничего. */
export const resolvePartCountLines = async (
  id: number,
  payload: { line_ids: number[]; decision: CountDecision; reason?: string; note?: string },
): Promise<PartCountDetail> => (await apiClient.post<PartCountDetail>(`/part-counts/${id}/resolve`, payload)).data;

export const listAreaParts = async (area: string): Promise<AreaPart[]> =>
  (await apiClient.get<AreaPart[]>(`/part-counts/area-parts/${encodeURIComponent(area)}`)).data;
