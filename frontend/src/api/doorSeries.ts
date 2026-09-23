import { apiClient } from "./client";

export type EdgeType = "abs" | "aluminum";

export interface DoorSeries {
  id: number;
  name: string;
  frame_thickness_mm: number;
  panel_mdf_thickness_mm: number;
  edge_type: EdgeType;
  has_glass: boolean;
  has_moulding: boolean;
  needs_lock_milling: boolean;
  milling_program: string | null;
  is_active: boolean;
}

export type DoorSeriesCreate = Omit<DoorSeries, "id" | "is_active">;
export type DoorSeriesUpdate = Partial<Omit<DoorSeries, "id">>;

export const listDoorSeries = async (): Promise<DoorSeries[]> => (await apiClient.get<DoorSeries[]>("/door-series")).data;

export const createDoorSeries = async (payload: DoorSeriesCreate): Promise<DoorSeries> =>
  (await apiClient.post<DoorSeries>("/door-series", payload)).data;

export const updateDoorSeries = async (id: number, payload: DoorSeriesUpdate): Promise<DoorSeries> =>
  (await apiClient.patch<DoorSeries>(`/door-series/${id}`, payload)).data;
