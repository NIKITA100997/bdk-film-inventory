import { apiClient } from "./client";

export interface PfDemandRow {
  part_id: number;
  part_name: string;
  min_stock: number | null;
  min_batch: number | null;
  task_demand: number;
  stock: number;
  in_work: number;
  need: number;
  shortage: number;
  suggested: number;
  first_stage_id: number;
  first_stage_name: string;
  first_stage_area: string | null;
}

export const listPfDemand = async (): Promise<PfDemandRow[]> => (await apiClient.get<PfDemandRow[]>("/pf-demand")).data;

export const createPfTasks = async (payload: {
  items: { part_id: number; quantity_pieces: number }[];
  ship_date?: string | null;
}): Promise<{ task_ids: number[] }> => (await apiClient.post<{ task_ids: number[] }>("/pf-demand/tasks", payload)).data;
