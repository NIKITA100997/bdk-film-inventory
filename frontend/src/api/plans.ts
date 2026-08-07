import { apiClient } from "./client";

export interface FilmRequestLine {
  id: number;
  material: string;
  color: string;
  thickness: number;
  planned_area_m2: number;
  current_stock_m2: number;
  shortage: boolean;
}

export interface WeeklyPlan {
  id: number;
  week_start: string;
  week_end: string;
  created_by: number;
  status: string;
  lines: FilmRequestLine[];
}

export interface FilmRequestLineCreate {
  material: string;
  color: string;
  thickness: number;
  planned_area_m2: number;
}

export interface PlanFactLine {
  line_id: number;
  material: string;
  color: string;
  thickness: number;
  planned_area_m2: number;
  actual_area_m2: number;
  percent_complete: number;
  by_width: Record<string, number>;
}

export interface PlanFactOut {
  week_id: number;
  week_start: string;
  week_end: string;
  lines: PlanFactLine[];
}

export async function createWeeklyPlan(payload: { week_start: string; week_end: string }): Promise<WeeklyPlan> {
  const { data } = await apiClient.post<WeeklyPlan>("/weekly-plans", payload);
  return data;
}

export async function listWeeklyPlans(): Promise<WeeklyPlan[]> {
  const { data } = await apiClient.get<WeeklyPlan[]>("/weekly-plans");
  return data;
}

export async function getWeeklyPlan(id: number): Promise<WeeklyPlan> {
  const { data } = await apiClient.get<WeeklyPlan>(`/weekly-plans/${id}`);
  return data;
}

export async function addFilmRequestLine(planId: number, payload: FilmRequestLineCreate): Promise<FilmRequestLine> {
  const { data } = await apiClient.post<FilmRequestLine>(`/weekly-plans/${planId}/lines`, payload);
  return data;
}

export async function getPlanFact(weekId: number): Promise<PlanFactOut> {
  const { data } = await apiClient.get<PlanFactOut>("/plan-fact", { params: { week_id: weekId } });
  return data;
}
