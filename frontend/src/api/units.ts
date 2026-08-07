import { apiClient } from "./client";

export interface MaterialUnit {
  id: number;
  parent_id: number | null;
  upd_number: string;
  pallet_number: string;
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  status: string;
  area: string | null;
  location_code: string | null;
  order_id: number | null;
  area_m2: number;
}

export interface ReceiveRequest {
  upd_number: string;
  pallet_number: string;
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  quantity: number;
  location_code?: string;
}

export async function receiveUnits(payload: ReceiveRequest): Promise<MaterialUnit[]> {
  const { data } = await apiClient.post<MaterialUnit[]>("/units/receive", payload);
  return data;
}

export async function getUnit(unitId: number): Promise<MaterialUnit> {
  const { data } = await apiClient.get<MaterialUnit>(`/units/${unitId}`);
  return data;
}

export interface SplitRequest {
  separate_width_mm: number;
  new_unit_location?: string;
}

export interface SplitResponse {
  parent: MaterialUnit;
  new_unit: MaterialUnit | null;
}

export async function splitUnit(unitId: number, payload: SplitRequest): Promise<SplitResponse> {
  const { data } = await apiClient.post<SplitResponse>(`/units/${unitId}/split`, payload);
  return data;
}

export interface IssueRequest {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  area: "okutka_tsargovykh" | "shchitovye_dveri" | "tselnolistovye_dveri";
  order_id?: number;
}

export async function issueUnit(payload: IssueRequest): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>("/units/issue", payload);
  return data;
}

export async function fetchLabelHtml(unitId: number): Promise<string> {
  const { data } = await apiClient.get<string>(`/labels/${unitId}`, { responseType: "text" });
  return data;
}

export function printLabel(unitId: number): void {
  fetchLabelHtml(unitId).then((html) => {
    const w = window.open("", "_blank", "width=400,height=600");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  });
}
