import { apiClient } from "./client";

// Монитор производства (08.10): все открытые задания участкам — план,
// сделано, брак. Срезы (по участкам, заказы × участки, лист участка) — на экране.

export interface MonitorArea {
  code: string;
  name: string;
  site: string | null;
  sort: number;
  per_day: number | null;
}

export interface MonitorOrder {
  id: number;
  name: string;
  ship_date: string | null;
  kind: string;
}

export interface MonitorRow {
  task_line_id: number;
  task_id: number;
  area: string;
  order_id: number | null;
  invoice_no: string | null;
  position: string;
  direction: string | null;
  film: string | null;
  program: string | null;
  plan: number;
  good: number;
  defect: number;
  closed: boolean;
  last_report: string | null;
  date_from: string | null;
  date_to: string | null;
  /** группа участка (08.10) */
  group?: string | null;
}

export interface Monitor {
  areas: MonitorArea[];
  orders: MonitorOrder[];
  rows: MonitorRow[];
}

export const getProductionMonitor = async (): Promise<Monitor> => (await apiClient.get<Monitor>("/production-monitor")).data;
