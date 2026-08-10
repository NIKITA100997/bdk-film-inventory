import { apiClient } from "./client";

export interface StockSummaryLine {
  material: string;
  color: string;
  thickness: number;
  total_area_m2: number;
  unit_count: number;
}

export interface StockByWidthLine {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  total_length_m: number;
  unit_count: number;
}

export interface MovementEntry {
  event_id: number;
  unit_id: number;
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  event_type: string;
  area: string | null;
  timestamp: string;
  width_mm: number;
  quantity_delta_m: number;
}

export interface DonorAccuracy {
  period_from: string;
  period_to: string;
  suggested: number;
  accepted: number;
  accuracy_percent: number;
}

export interface StaleUnitLine {
  unit_id: number;
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  location_code: string | null;
  last_moved_at: string;
  days_idle: number;
}

export const getStockSummary = async (): Promise<StockSummaryLine[]> =>
  (await apiClient.get<StockSummaryLine[]>("/reports/stock-summary")).data;

export const getStockByWidth = async (): Promise<StockByWidthLine[]> =>
  (await apiClient.get<StockByWidthLine[]>("/reports/stock-by-width")).data;

export const getMovement = async (dateFrom: string, dateTo: string, materialSkuId?: number): Promise<MovementEntry[]> =>
  (
    await apiClient.get<MovementEntry[]>("/reports/movement", {
      params: { date_from: dateFrom, date_to: dateTo, material_sku_id: materialSkuId },
    })
  ).data;

export const getDonorAccuracy = async (dateFrom: string, dateTo: string): Promise<DonorAccuracy> =>
  (
    await apiClient.get<DonorAccuracy>("/reports/donor-accuracy", {
      params: { date_from: dateFrom, date_to: dateTo },
    })
  ).data;

export const getStaleUnits = async (thresholdDays?: number): Promise<StaleUnitLine[]> =>
  (
    await apiClient.get<StaleUnitLine[]>("/reports/stale-units", {
      params: thresholdDays ? { threshold_days: thresholdDays } : undefined,
    })
  ).data;
