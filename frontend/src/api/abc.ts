import { apiClient } from "./client";

export type WidthClass = "A" | "B" | "C";

export interface WidthAbcClassEntry {
  id: number;
  material: string;
  color: string;
  thickness: number;
  width_mm: number;
  width_class: WidthClass;
  total_length_m: number;
  computed_at: string;
}

export interface CalcSettings {
  min_useful_width_mm: number;
  abc_recalc_period_days: number;
  cells_per_strip_shelf: number;
  stale_threshold_days: number;
  shortage_note_template: string;
  updated_at: string;
}

export async function listAbcClasses(widthClass?: WidthClass): Promise<WidthAbcClassEntry[]> {
  const { data } = await apiClient.get<WidthAbcClassEntry[]>("/abc/classes", {
    params: widthClass ? { width_class: widthClass } : undefined,
  });
  return data;
}

export async function recomputeAbc(periodDays?: number): Promise<{ updated: number; period_days: number }> {
  const { data } = await apiClient.post("/abc/recompute", null, {
    params: periodDays ? { period_days: periodDays } : undefined,
  });
  return data;
}

export async function getCalcSettings(): Promise<CalcSettings> {
  const { data } = await apiClient.get<CalcSettings>("/calc-settings");
  return data;
}

export async function updateCalcSettings(payload: {
  min_useful_width_mm: number;
  abc_recalc_period_days: number;
  cells_per_strip_shelf: number;
  stale_threshold_days: number;
  shortage_note_template: string;
}): Promise<CalcSettings> {
  const { data } = await apiClient.patch<CalcSettings>("/calc-settings", payload);
  return data;
}
