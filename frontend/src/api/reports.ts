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

export interface CuttingDiscrepancyLine {
  event_id: number;
  unit_id: number;
  area: string | null;
  task_name: string | null;
  part_name: string | null;
  material: string;
  color: string;
  thickness: number;
  expected_length_m: number;
  actual_length_m: number;
  discrepancy_m: number;
  discrepancy_percent: number;
  timestamp: string;
  user_id: number;
}

export const getCuttingDiscrepancies = async (dateFrom: string, dateTo: string): Promise<CuttingDiscrepancyLine[]> =>
  (
    await apiClient.get<CuttingDiscrepancyLine[]>("/reports/cutting-discrepancies", {
      params: { date_from: dateFrom, date_to: dateTo },
    })
  ).data;

// ---------- Раздел про модуль "Брак и списания" ----------

export interface WriteOffLine {
  event_id: number;
  unit_id: number;
  timestamp: string;
  material: string;
  color: string;
  thickness: number;
  width_mm: number;
  quantity_m: number;
  reason_code: string | null;
  reason_name: string | null;
  note: string | null;
  user_name: string;
  is_cutting_waste: boolean;
}

export const getWriteOffs = async (
  dateFrom: string,
  dateTo: string,
  params?: { materialSkuId?: number; reason?: string; includeCuttingWaste?: boolean },
): Promise<WriteOffLine[]> =>
  (
    await apiClient.get<WriteOffLine[]>("/reports/write-offs", {
      params: {
        date_from: dateFrom,
        date_to: dateTo,
        material_sku_id: params?.materialSkuId,
        reason: params?.reason,
        include_cutting_waste: params?.includeCuttingWaste,
      },
    })
  ).data;

export interface ProductionDefectLine {
  report_id: number;
  reported_at: string;
  task_id: number;
  task_name: string | null;
  part_name: string | null;
  area: string;
  area_name: string;
  line_id: number | null;
  line_name: string | null;
  defect_pieces: number;
  good_pieces: number;
  reason_code: string | null;
  reason_name: string | null;
  note: string | null;
  reported_by_name: string;
}

export const getProductionDefects = async (
  dateFrom: string,
  dateTo: string,
  params?: { area?: string; lineId?: number; taskId?: number; reason?: string },
): Promise<ProductionDefectLine[]> =>
  (
    await apiClient.get<ProductionDefectLine[]>("/reports/production-defects", {
      params: {
        date_from: dateFrom,
        date_to: dateTo,
        area: params?.area,
        line_id: params?.lineId,
        task_id: params?.taskId,
        reason: params?.reason,
      },
    })
  ).data;

export interface ReasonShareLine {
  reason_name: string;
  amount: number;
  share_percent: number;
}

export interface TopWriteOffMaterialLine {
  material: string;
  color: string;
  thickness: number;
  amount_m: number;
  events: number;
}

export interface TopDefectGroupLine {
  level: "area" | "line";
  label: string;
  parent_label: string | null;
  defect_pieces: number;
  good_pieces: number;
  defect_rate_percent: number;
}

export interface DefectsOverviewOut {
  period_from: string;
  period_to: string;
  warehouse_total_m: number;
  warehouse_total_m_delta_percent: number | null;
  warehouse_cutting_waste_m: number;
  warehouse_real_defect_m: number;
  warehouse_real_defect_m_delta_percent: number | null;
  warehouse_events_count: number;
  production_defect_pieces: number;
  production_defect_pieces_delta_percent: number | null;
  production_good_pieces: number;
  production_defect_rate_percent: number;
  warehouse_reasons: ReasonShareLine[];
  production_reasons: ReasonShareLine[];
  top_materials: TopWriteOffMaterialLine[];
  top_defect_groups: TopDefectGroupLine[];
}

export const getDefectsOverview = async (dateFrom: string, dateTo: string): Promise<DefectsOverviewOut> =>
  (
    await apiClient.get<DefectsOverviewOut>("/reports/defects-overview", {
      params: { date_from: dateFrom, date_to: dateTo },
    })
  ).data;

export interface TrendPoint {
  period_from: string;
  period_to: string;
  label: string;
  warehouse_m: number;
  production_defect_pieces: number;
}

export const getDefectsTrend = async (dateFrom: string, dateTo: string, bucketDays = 7): Promise<TrendPoint[]> =>
  (
    await apiClient.get<TrendPoint[]>("/reports/defects-trend", {
      params: { date_from: dateFrom, date_to: dateTo, bucket_days: bucketDays },
    })
  ).data;

export type DefectPivotGroupBy = "detail" | "area" | "line";

export interface DefectPivotRowOut {
  group_label: string;
  parent_label: string | null;
  by_reason: Record<string, number>;
  defect_pieces: number;
  good_pieces: number;
  defect_rate_percent: number;
}

export interface DefectPivotOut {
  group_by: DefectPivotGroupBy;
  reasons: string[];
  rows: DefectPivotRowOut[];
  total: DefectPivotRowOut;
}

export const getDefectsPivot = async (dateFrom: string, dateTo: string, groupBy: DefectPivotGroupBy): Promise<DefectPivotOut> =>
  (
    await apiClient.get<DefectPivotOut>("/reports/defects-pivot", {
      params: { date_from: dateFrom, date_to: dateTo, group_by: groupBy },
    })
  ).data;
