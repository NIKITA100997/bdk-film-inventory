import { apiClient } from "./client";

// «Ежедневка» (06.10) — дневной бланк линии/участка из отчётов мастеров.
export interface DailySheetRow {
  task_id: number;
  task_name: string | null;
  part_name: string | null;
  film: string | null;
  strip_width_mm: number | null;
  roll_id: number | null;
  received_m: number | null;
  produced: number;
  defect: number;
  passed: number;
  consumed_m: number;
  remaining_m: number | null;
  line_name: string | null;
}

export interface DailySheet {
  area: string;
  area_name: string;
  date: string;
  line_id: number | null;
  line_name: string | null;
  lines: { id: number; name: string }[];
  rows: DailySheetRow[];
  without_line: number;
}

export const getDailySheet = async (area: string, date: string, lineId?: number | null): Promise<DailySheet> =>
  (await apiClient.get<DailySheet>("/daily-sheet", { params: { area, date, line_id: lineId ?? undefined } })).data;
