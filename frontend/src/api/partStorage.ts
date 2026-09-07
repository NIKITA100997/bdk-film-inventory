import { apiClient } from "./client";
import type { PartUnit } from "./partUnits";

// Стеллаж п/ф (раздел про адресное хранение деталей) — параллельная
// Rack/storage.ts, без типа (рулонный/штрипсовый), склада и лимитов
// занятости полки: п/ф считается в штуках, живёт в одном цехе, полка —
// просто адрес, не ограничитель (см. BDK_Учет_ПФ_план.md).
export interface PartRack {
  id: number;
  code: string;
  shelf_count: number;
  is_active: boolean;
}

export interface PartRackOccupancyCell {
  shelf: number;
  location_code: string;
  units: PartUnit[];
}

export const listPartRacks = async (): Promise<PartRack[]> => (await apiClient.get<PartRack[]>("/part-racks")).data;

export const createPartRack = async (payload: { code: string; shelf_count: number }): Promise<PartRack> =>
  (await apiClient.post<PartRack>("/part-racks", payload)).data;

export const getPartRackOccupancy = async (rackId: number): Promise<PartRackOccupancyCell[]> =>
  (await apiClient.get<PartRackOccupancyCell[]>(`/part-racks/${rackId}/occupancy`)).data;

export const placePartUnit = async (unitId: number, locationCode: string): Promise<PartUnit> =>
  (await apiClient.patch<PartUnit>(`/part-units/${unitId}/place`, { location_code: locationCode })).data;
