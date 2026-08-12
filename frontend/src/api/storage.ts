import { apiClient } from "./client";
import type { MaterialUnit } from "./units";

export type RackType = "roll" | "strip";

export interface Warehouse {
  id: number;
  name: string;
  address: string | null;
  is_active: boolean;
}

export interface WarehouseCreate {
  name: string;
  address?: string;
}

export interface WarehouseUpdate {
  name?: string;
  address?: string;
  is_active?: boolean;
}

export interface Rack {
  id: number;
  code: string;
  type: RackType;
  shelf_count: number;
  warehouse_id: number;
  is_active: boolean;
}

export interface RackUpdate {
  code?: string;
  type?: RackType;
  shelf_count?: number;
  warehouse_id?: number;
  is_active?: boolean;
}

export const listWarehouses = async (): Promise<Warehouse[]> =>
  (await apiClient.get<Warehouse[]>("/warehouses")).data;

export const createWarehouse = async (payload: WarehouseCreate): Promise<Warehouse> =>
  (await apiClient.post<Warehouse>("/warehouses", payload)).data;

export const updateWarehouse = async (warehouseId: number, payload: WarehouseUpdate): Promise<Warehouse> =>
  (await apiClient.patch<Warehouse>(`/warehouses/${warehouseId}`, payload)).data;

export interface MacroZoneRule {
  id: number;
  rack_id: number;
  from_shelf: number;
  to_shelf: number;
  material_id: number | null;
  color_id: number | null;
  thickness_id: number | null;
  manufacturer_id: number | null;
}

export interface MacroZoneRuleCreate {
  from_shelf: number;
  to_shelf: number;
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
}

export const listRacks = async (warehouseId?: number): Promise<Rack[]> =>
  (await apiClient.get<Rack[]>("/racks", { params: warehouseId ? { warehouse_id: warehouseId } : undefined })).data;

export const createRack = async (payload: {
  code: string;
  type: RackType;
  shelf_count: number;
  warehouse_id: number;
}): Promise<Rack> => (await apiClient.post<Rack>("/racks", payload)).data;

export const updateRack = async (rackId: number, payload: RackUpdate): Promise<Rack> =>
  (await apiClient.patch<Rack>(`/racks/${rackId}`, payload)).data;

export const listMacroZoneRules = async (rackId: number): Promise<MacroZoneRule[]> =>
  (await apiClient.get<MacroZoneRule[]>(`/racks/${rackId}/macro-zone-rules`)).data;

export const createMacroZoneRule = async (rackId: number, payload: MacroZoneRuleCreate): Promise<MacroZoneRule> =>
  (await apiClient.post<MacroZoneRule>(`/racks/${rackId}/macro-zone-rules`, payload)).data;

export const deleteMacroZoneRule = async (rackId: number, ruleId: number): Promise<void> => {
  await apiClient.delete(`/racks/${rackId}/macro-zone-rules/${ruleId}`);
};

export interface RackOccupancyCell {
  shelf: number;
  cell: number | null;
  location_code: string;
  unit: MaterialUnit | null;
}

export const getRackOccupancy = async (rackId: number): Promise<RackOccupancyCell[]> =>
  (await apiClient.get<RackOccupancyCell[]>(`/racks/${rackId}/occupancy`)).data;

export const suggestLocation = async (params: {
  material_sku_id: number;
  width_mm: number;
  parent_id?: number | null;
  warehouse_id?: number;
}): Promise<string | null> =>
  (await apiClient.get<{ location_code: string | null }>("/storage/suggest-location", { params })).data
    .location_code;
