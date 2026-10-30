import { apiClient } from "./client";

export interface PickRouteItem {
  pick_id: string;
  unit_id: number | null;
  location_code: string;
  rack_code: string;
  shelf_num: number;
  task_id: number;
  task_name: string;
  task_line_id: number;
  target_area: string;
  target_area_name: string;
  decor_name: string;
  material_name: string;
  color_name: string;
  width_mm: number;
  length_needed_m: number;
  unit_length_m: number | null;
  barcode: string | null;
  is_verified: boolean;
}

export interface PickRouteWave {
  wave_id: string;
  created_at: string;
  target_area: string | null;
  total_items: number;
  total_meters: number;
  distinct_racks_count: number;
  items: PickRouteItem[];
}

export interface VerifyPickResult {
  verified: boolean;
  unit_id?: number;
  location_code?: string;
  length_m?: number;
  width_mm?: number;
  message?: string;
  error?: string;
}

export async function getPickRoute(area?: string): Promise<PickRouteWave> {
  const { data } = await apiClient.get<PickRouteWave>("/units/pick-route", {
    params: area ? { area } : {},
  });
  return data;
}

export async function verifyPickItem(
  scannedBarcode: string,
  expectedTaskLineId: number
): Promise<VerifyPickResult> {
  const { data } = await apiClient.post<VerifyPickResult>("/units/verify-pick", {
    scanned_barcode: scannedBarcode,
    expected_task_line_id: expectedTaskLineId,
  });
  return data;
}
