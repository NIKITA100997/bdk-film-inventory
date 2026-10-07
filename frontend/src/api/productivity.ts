import { apiClient } from "./client";

// Производительность участков (07.10): выпуск по отчётам мастеров и выдача плёнки.

export interface OutputRow {
  day: string;
  area: string;
  area_name: string;
  position: string;
  good: number;
  defect: number;
  film_m: number;
  reports: number;
  closed_whole: number;
}

export interface IssueRow {
  day: string;
  area: string;
  area_name: string;
  film: string;
  rolls: number;
  strips: number;
  length_m: number;
  area_m2: number;
}

export interface AreaTotal {
  area: string;
  area_name: string;
  good: number;
  defect: number;
  defect_percent: number | null;
  days_with_output: number;
  good_per_day: number | null;
  film_used_m: number;
  issued_m: number;
  issued_m2: number;
  issued_units: number;
}

export interface Productivity {
  date_from: string;
  date_to: string;
  totals: AreaTotal[];
  output: OutputRow[];
  issues: IssueRow[];
}

export const getProductivity = async (p: { date_from: string; date_to: string; area?: string }): Promise<Productivity> =>
  (await apiClient.get<Productivity>("/productivity", { params: p })).data;
