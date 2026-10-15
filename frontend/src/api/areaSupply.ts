import { apiClient } from "./client";

/** Снабжение участков (15.10): заявки участков, неснижаемый остаток,
 * факт резки и выдачи плёнки, станки резки. Одно для плёнки, п/ф и материалов. */
export type SupplyKind = "plenka" | "pf" | "material";

export interface CatalogItem {
  item_id: number;
  kind: SupplyKind;
  label: string;
  unit: string;
  measurable: boolean;
}

export type RequestStatus = "new" | "accepted" | "done" | "cancelled";

export interface AreaRequest {
  id: number;
  area: string;
  area_name: string;
  item_id: number | null;
  kind: SupplyKind | null;
  label: string;
  qty: number | null;
  unit: string | null;
  width_mm: number | null;
  needed_by: string | null;
  note: string | null;
  status: RequestStatus;
  created_by_name: string | null;
  created_at: string;
  closed_by_name: string | null;
  closed_at: string | null;
  close_note: string | null;
  area_stock: number | null;
  issued_qty: number;
  warehouse_stock_m2: number | null;
}

export interface AreaRequestIn {
  area: string;
  item_id?: number | null;
  what?: string | null;
  qty?: number | null;
  width_mm?: number | null;
  needed_by?: string | null;
  note?: string | null;
}

export interface AreaNorm {
  id: number;
  area: string;
  area_name: string;
  item_id: number;
  kind: SupplyKind;
  label: string;
  unit: string;
  min_qty: number;
  have: number;
  short: number;
  open_request_id: number | null;
}

export interface IssueFactDay {
  day: string;
  issued_m2: number;
  issued_units: number;
  cut_ops: number;
  cut_m2: number;
  by_line: Record<string, number>;
}

export const searchSupplyCatalog = async (params: { kind?: SupplyKind; q?: string }) =>
  (await apiClient.get<CatalogItem[]>("/area-supply/catalog", { params })).data;
export const listAreaRequests = async (params: { open_only?: boolean; kind?: SupplyKind; area?: string }) =>
  (await apiClient.get<AreaRequest[]>("/area-supply/requests", { params })).data;
export const createAreaRequest = async (p: AreaRequestIn) => (await apiClient.post<AreaRequest>("/area-supply/requests", p)).data;
export const acceptAreaRequest = async (id: number) => (await apiClient.post<AreaRequest>(`/area-supply/requests/${id}/accept`)).data;
export const doneAreaRequest = async (id: number, note?: string) =>
  (await apiClient.post<AreaRequest>(`/area-supply/requests/${id}/done`, { note: note || null })).data;
export const cancelAreaRequest = async (id: number, note?: string) =>
  (await apiClient.post<AreaRequest>(`/area-supply/requests/${id}/cancel`, { note: note || null })).data;
export const listAreaNorms = async (area?: string) => (await apiClient.get<AreaNorm[]>("/area-supply/norms", { params: { area } })).data;
export const putAreaNorm = async (p: { area: string; item_id: number; min_qty: number }) => (await apiClient.put("/area-supply/norms", p)).data;
export const getIssueFact = async (days = 14) =>
  (await apiClient.get<{ lines: string[]; days: IssueFactDay[] }>("/area-supply/issue-fact", { params: { days } })).data;
export const getAreaRequestsSummary = async () =>
  (await apiClient.get<{ new: number; open: number }>("/area-supply/requests/summary")).data;
export const listCuttingLines = async () => (await apiClient.get<{ id: number; name: string }[]>("/area-supply/cutting-lines")).data;
