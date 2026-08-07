import { apiClient } from "./client";

export type RackType = "roll" | "strip";

export interface Rack {
  id: number;
  code: string;
  type: RackType;
}

export interface Shelf {
  id: number;
  rack_id: number;
  number: number;
  macro_zone: string | null;
}

export interface Cell {
  id: number;
  shelf_id: number;
  number: number;
}

export const listRacks = async (): Promise<Rack[]> => (await apiClient.get<Rack[]>("/racks")).data;

export const createRack = async (payload: { code: string; type: RackType }): Promise<Rack> =>
  (await apiClient.post<Rack>("/racks", payload)).data;

export const listShelves = async (rackId: number): Promise<Shelf[]> =>
  (await apiClient.get<Shelf[]>(`/racks/${rackId}/shelves`)).data;

export const createShelf = async (rackId: number, payload: { number: number; macro_zone?: string }): Promise<Shelf> =>
  (await apiClient.post<Shelf>(`/racks/${rackId}/shelves`, payload)).data;

export const listCells = async (shelfId: number): Promise<Cell[]> =>
  (await apiClient.get<Cell[]>(`/shelves/${shelfId}/cells`)).data;

export const createCell = async (shelfId: number, payload: { number: number }): Promise<Cell> =>
  (await apiClient.post<Cell>(`/shelves/${shelfId}/cells`, payload)).data;
