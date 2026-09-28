import { apiClient } from "./client";

export interface PfDemandSource {
  task_id: number;
  task_name: string;
  open_plan: number;
  done: number;
  remaining: number;
  /** Явный резерв, как его ввели. */
  reserve_set: number;
  /** Обеспечено остатком: резерв + сделанное по заданиям п/ф под это задание. */
  reserved: number;
  /** Производится под это задание. */
  in_work: number;
  shortage: number;
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
  /** Остатка в резерве под задания цеха. */
  reserved: number;
  /** Остаток без резервов. */
  free: number;
}

// indexes: null — task_ids=1&task_ids=2, как ждёт FastAPI, а не task_ids[]=1.
export const listPfDemand = async (taskIds: number[] = []): Promise<PfDemandRow[]> =>
  (
    await apiClient.get<PfDemandRow[]>("/pf-demand", {
      params: taskIds.length ? { task_ids: taskIds } : undefined,
      paramsSerializer: { indexes: null },
    })
  ).data;

export interface PfPreviewItem {
  part_id?: number;
  part_name?: string;
  width_mm?: number;
  length_m?: number;
  quantity_pieces: number;
}

/** Обеспечение п/ф задания, которое ещё только составляют. */
export const previewPfDemand = async (items: PfPreviewItem[]): Promise<PfDemandRow[]> =>
  (await apiClient.post<PfDemandRow[]>("/pf-demand/preview", { items })).data;

/** Резерв детали на задание цеха, шт; 0 — снять. */
export const setPfReservation = async (payload: { task_id: number; part_id: number; quantity_pieces: number }): Promise<void> => {
  await apiClient.put("/pf-demand/reservations", payload);
};

export const createPfTasks = async (payload: {
  items: { part_id: number; quantity_pieces: number }[];
  ship_date?: string | null;
  for_task_id?: number | null;
}): Promise<{ task_ids: number[] }> => (await apiClient.post<{ task_ids: number[] }>("/pf-demand/tasks", payload)).data;
