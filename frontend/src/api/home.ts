import { apiClient } from "./client";

export interface AreaCapacityMetric {
  area_code: string;
  name: string;
  queue_pieces: number;
  capacity_per_day: number;
  days_of_work: number;
  load_pct: number;
  is_bottleneck: boolean;
}

export interface ActionInsight {
  level: "danger" | "warning" | "info" | "success";
  title: string;
  text: string;
  action_label?: string | null;
  action_link?: string | null;
}

export interface FactoryPulse {
  output_pieces_today: number;
  output_rub_today: number;
  plan_completion_pct: number;
  planned_pieces_today: number;
  defect_pieces_today: number;
  defect_pct_today: number;
  delayed_orders_count: number;
  overdue_pieces_total: number;
  area_balances: AreaCapacityMetric[];
  insights: ActionInsight[];
}

/** «Общее» (28.10): набор модулей главной у пользователя; null — стандартный по ролям. */
export const getHomeModules = async (): Promise<string[] | null> => (await apiClient.get<{ modules: string[] | null }>("/home")).data.modules;
export const setHomeModules = async (modules: string[] | null): Promise<string[] | null> =>
  (await apiClient.put<{ modules: string[] | null }>("/home", { modules })).data.modules;

export const getFactoryPulse = async (targetDate?: string): Promise<FactoryPulse> =>
  (await apiClient.get<FactoryPulse>("/home/pulse", { params: targetDate ? { target_date: targetDate } : {} })).data;
