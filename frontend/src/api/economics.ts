import { apiClient } from "./client";

/** План/факт плёнки по строке задания (см. services/production_economics). */
export interface FilmPlanFactRow {
  line_id: number;
  task_id: number;
  area: string;
  area_name: string;
  order: string | null;
  invoice_no: string | null;
  part_name: string | null;
  film: string;
  width_mm: number;
  good: number;
  defect: number;
  rolls: number;
  no_roll_pieces: number;
  norm_m: number;
  defect_m: number;
  fact_m: number | null;
  over_m: number | null;
  over_pct: number | null;
  price_m2: number | null;
  fact_rub: number | null;
  over_rub: number | null;
  in_work: boolean;
}

/** Выработка: сотрудник × участок × день. */
export interface OutputRow {
  user: string;
  area: string;
  area_name: string;
  date: string;
  good: number;
  defect: number;
  reports: number;
  lines: number;
  defect_pct: number;
  capacity: number | null;
}

type Period = { date_from: string; date_to: string; area?: string };

export const getFilmPlanFact = async (p: Period): Promise<FilmPlanFactRow[]> =>
  (await apiClient.get<FilmPlanFactRow[]>("/reports/film-plan-fact", { params: p })).data;
export const getOutput = async (p: Period): Promise<OutputRow[]> => (await apiClient.get<OutputRow[]>("/reports/output", { params: p })).data;

/** Ежедневная выработка: участки (годные/брак) и склад плёнки (операции/метры). */
export interface DailyCell {
  value: number;
  extra: number;
  users: { user: string; value: number; extra: number }[];
}
export interface DailyRow {
  group: "production" | "warehouse";
  key: string;
  label: string;
  value_label: string;
  extra_label: string;
  capacity: number | null;
  by_day: Record<string, DailyCell>;
  total: number;
  total_extra: number;
}
export const getDailyOutput = async (p: { date_from: string; date_to: string }): Promise<{ days: string[]; rows: DailyRow[] }> =>
  (await apiClient.get<{ days: string[]; rows: DailyRow[] }>("/reports/daily-output", { params: p })).data;

/** Себестоимость по участкам за период (работа, плёнка, материалы). */
export interface AreaCostRow {
  area: string;
  area_name: string;
  pay_mode: "piece" | "shift" | null;
  good: number;
  defect: number;
  days: number;
  labor_rub: number;
  film_rub: number;
  materials_rub: number;
  total_rub: number;
  per_piece_rub: number | null;
  issues: string[];
}
export const getAreaCosts = async (p: { date_from: string; date_to: string }): Promise<AreaCostRow[]> =>
  (await apiClient.get<AreaCostRow[]>("/reports/area-costs", { params: p })).data;
