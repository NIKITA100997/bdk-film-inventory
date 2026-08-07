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
