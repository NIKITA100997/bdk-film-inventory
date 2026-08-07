import { apiClient } from "./client";
import type { MaterialUnit } from "./units";

export type InventoryScopeType = "rack" | "warehouse" | "material_sku";
export type InventoryStatus = "in_progress" | "closed";

export interface InventorySession {
  id: number;
  scope_type: InventoryScopeType;
  scope_ref_id: number | null;
  status: InventoryStatus;
  started_by: number;
  closed_by: number | null;
  started_at: string;
  closed_at: string | null;
  expected_count: number;
  scanned_count: number;
}

export interface ScanRequest {
  location_code: string;
  unit_id?: number;
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
  width_mm?: number;
  length_m?: number;
}

export interface ScanResult {
  outcome: "confirmed" | "moved" | "surplus";
  unit: MaterialUnit;
}

export interface Shortage {
  id: number;
  material_sku_id: number;
  width_mm: number;
  length_m: number;
  location_code: string | null;
}

export interface CloseSessionResult {
  session: InventorySession;
  confirmed_count: number;
  moved_count: number;
  surplus_count: number;
  shortages: Shortage[];
}

export async function startSession(payload: { scope_type: InventoryScopeType; scope_ref_id?: number }): Promise<InventorySession> {
  const { data } = await apiClient.post<InventorySession>("/inventory-sessions", payload);
  return data;
}

export async function getSession(id: number): Promise<InventorySession> {
  const { data } = await apiClient.get<InventorySession>(`/inventory-sessions/${id}`);
  return data;
}

export async function scanUnit(sessionId: number, payload: ScanRequest): Promise<ScanResult> {
  const { data } = await apiClient.post<ScanResult>(`/inventory-sessions/${sessionId}/scan`, payload);
  return data;
}

export async function closeSession(sessionId: number): Promise<CloseSessionResult> {
  const { data } = await apiClient.post<CloseSessionResult>(`/inventory-sessions/${sessionId}/close`);
  return data;
}

export async function resolveShortage(
  sessionId: number,
  unitId: number,
  action: "spisat" | "vernut_v_poisk",
): Promise<InventorySession> {
  const { data } = await apiClient.post<InventorySession>(`/inventory-sessions/${sessionId}/resolve-shortage/${unitId}`, {
    action,
  });
  return data;
}
