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
  /** строка заказа (13.10): раскрытие заказа по строкам */
  order_line_id?: number | null;
  line_qty?: number | null;
  series?: string;
  size?: string;
  color?: string;
  source?: string;
  /** выдача плёнки (16.10): issued / covered — есть, partial — частично, none — нет, site_stock — со склада Фабрики */
  film_status?: "issued" | "covered" | "partial" | "none" | "site_stock" | null;
  film_need_m?: number | null;
  film_to_issue_m?: number | null;
  /** монитор по заказам (21.10): операция маршрута и её порядок, деталь п/ф, задание,
   * можно ли отчитаться из монитора (без рулона и дневного плана), дата запуска заказа */
  operation?: string | null;
  op_seq?: number | null;
  part_id?: number | null;
  task_name?: string | null;
  quick?: boolean;
  launch_date?: string | null;
}

export interface Monitor {
  areas: MonitorArea[];
  orders: MonitorOrder[];
  rows: MonitorRow[];
}

/** includeDone — и задания, закрытые целиком (готовые строки не пропадают). */
export const getProductionMonitor = async (includeDone = false): Promise<Monitor> =>
  (await apiClient.get<Monitor>("/production-monitor", { params: includeDone ? { include_done: true } : undefined })).data;
