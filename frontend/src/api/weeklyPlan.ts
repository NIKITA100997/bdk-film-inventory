import { apiClient } from "./client";

/** План недели (12.10, этап 3). */
export interface PlanOrder {
  id: number;
  name: string;
  customer: string | null;
  priority: number;
  state: "запущен" | "принят" | "заявка";
  qty: number;
  promised_ready: string | null;
  ship_date: string | null;
  plan_finish: string | null;
  plan_late: boolean;
  in_approved: boolean;
  moved: boolean;
  load: Record<string, number>;
}
export interface WeeklyPlan {
  week_start: string;
  status: "draft" | "submitted" | "approved" | "changed";
  version: number;
  comment: string | null;
  submitted_by_name: string | null;
  submitted_at: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  can_approve: boolean;
  can_manage: boolean;
  days: string[];
  orders: PlanOrder[];
  requests: PlanOrder[];
  removed: string[];
  areas: { area: string; name: string; by_day: number[]; capacity: (number | null)[] }[];
  events: { kind: string; text: string; user_name: string | null; created_at: string }[];
}

export const getWeeklyPlan = async (week: string): Promise<WeeklyPlan> =>
  (await apiClient.get<WeeklyPlan>("/weekly-plan", { params: { week } })).data;
export const submitWeeklyPlan = async (week: string, comment: string | null) =>
  (await apiClient.post<WeeklyPlan>(`/weekly-plan/${week}/submit`, { comment })).data;
export const approveWeeklyPlan = async (week: string, comment: string | null) =>
  (await apiClient.post<WeeklyPlan>(`/weekly-plan/${week}/approve`, { comment })).data;
export const returnWeeklyPlan = async (week: string, comment: string) =>
  (await apiClient.post<WeeklyPlan>(`/weekly-plan/${week}/return`, { comment })).data;
export const launchWeeklyPlan = async (week: string) =>
  (await apiClient.post<{ launched: number[]; failed: string[] }>(`/weekly-plan/${week}/launch`)).data;
