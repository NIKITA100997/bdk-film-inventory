import { apiClient } from "./client";
import type { MaterialUnit } from "./units";

export interface WarehouseTransferLine {
  id: number;
  unit: MaterialUnit;
  added_at: string;
  received_at: string | null;
}

export interface WarehouseTransfer {
  id: number;
  from_warehouse_id: number;
  from_warehouse_name: string;
  to_warehouse_id: number;
  to_warehouse_name: string;
  status: "sobiraetsya" | "otpravleno" | "prinyato";
  note: string | null;
  created_at: string;
  shipped_at: string | null;
  received_at: string | null;
  lines: WarehouseTransferLine[];
}

export async function listWarehouseTransfers(params?: {
  status_filter?: string;
  to_warehouse_id?: number;
}): Promise<WarehouseTransfer[]> {
  const { data } = await apiClient.get<WarehouseTransfer[]>("/warehouse-transfers", { params });
  return data;
}

export async function addUnitToTransfer(payload: {
  unit_id: number;
  to_warehouse_id: number;
  note?: string;
  occurred_at?: string;
}): Promise<WarehouseTransfer> {
  const { data } = await apiClient.post<WarehouseTransfer>("/warehouse-transfers/add-unit", payload);
  return data;
}

export async function removeTransferLine(transferId: number, lineId: number): Promise<WarehouseTransfer> {
  const { data } = await apiClient.post<WarehouseTransfer>(`/warehouse-transfers/${transferId}/lines/${lineId}/remove`);
  return data;
}

export async function shipTransfer(transferId: number): Promise<WarehouseTransfer> {
  const { data } = await apiClient.post<WarehouseTransfer>(`/warehouse-transfers/${transferId}/ship`);
  return data;
}

export async function receiveTransferLine(transferId: number, lineId: number, occurredAt?: string): Promise<WarehouseTransfer> {
  const { data } = await apiClient.post<WarehouseTransfer>(`/warehouse-transfers/${transferId}/lines/${lineId}/receive`, {
    occurred_at: occurredAt,
  });
  return data;
}

export async function receiveAllTransferLines(transferId: number, occurredAt?: string): Promise<WarehouseTransfer> {
  const { data } = await apiClient.post<WarehouseTransfer>(`/warehouse-transfers/${transferId}/receive-all`, {
    occurred_at: occurredAt,
  });
  return data;
}
