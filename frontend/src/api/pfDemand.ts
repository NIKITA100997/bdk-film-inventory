import { apiClient } from "./client";

export interface PfDemandSource {
  task_id: number;
  task_name: string;
  open_plan: number;
  done: number;
  remaining: number;
}

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
  sources: PfDemandSource[];
}

// indexes: null — task_ids=1&task_ids=2, как ждёт FastAPI, а не task_ids[]=1.
export const listPfDemand = async (taskIds: number[] = []): Promise<PfDemandRow[]> =>
  (
    await apiClient.get<PfDemandRow[]>("/pf-demand", {
      params: taskIds.length ? { task_ids: taskIds } : undefined,
      paramsSerializer: { indexes: null },
    })
  ).data;

export const createPfTasks = async (payload: {
  items: { part_id: number; quantity_pieces: number }[];
  ship_date?: string | null;
}): Promise<{ task_ids: number[] }> => (await apiClient.post<{ task_ids: number[] }>("/pf-demand/tasks", payload)).data;
