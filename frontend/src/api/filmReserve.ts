import { apiClient } from "./client";

/** Резерв плёнки под заказ (15.10): метры на рулонах склада, закреплённые
 * за строкой задания или за заказом клиента. */
export interface FilmReserveStats {
  days: number;
  defect_pct: number;
  startup_pct: number;
  over_plan_pct: number;
  suggested_pct: number;
}

export interface FilmReserveSettings {
  enabled: boolean;
  extra_pct: number;
  stats: FilmReserveStats;
}

export interface FilmReserveResult {
  reserved_m2: number;
  short_m2: number;
  lines: number;
}

export interface FilmReservation {
  id: number;
  unit_id: number;
  unit_label: string;
  location_code: string | null;
  length_m: number;
  area_m2: number;
  strip_width_mm: number | null;
  task_line_id: number | null;
  task_name: string | null;
  customer_order_id: number | null;
  invoice_no: string | null;
  created_at: string;
  spec_key: string;
  film: string;
}

export interface FilmReserveGroup {
  spec_key: string;
  film: string;
  stock_m2: number;
  reserved_m2: number;
  free_m2: number;
  reservations: number;
}

export const getFilmReserveSettings = async () => (await apiClient.get<FilmReserveSettings>("/film-reserve/settings")).data;
export const saveFilmReserveSettings = async (s: { enabled: boolean; extra_pct: number }) =>
  (await apiClient.put<FilmReserveSettings>("/film-reserve/settings", s)).data;
export const listFilmReservations = async (params: { customer_order_id?: number; task_id?: number; unit_id?: number }) =>
  (await apiClient.get<FilmReservation[]>("/film-reserve", { params })).data;
export const getFilmReserveSummary = async () => (await apiClient.get<FilmReserveGroup[]>("/film-reserve/summary")).data;
export const reserveFilmForCustomerOrder = async (coId: number) =>
  (await apiClient.post<FilmReserveResult>(`/film-reserve/customer-orders/${coId}`)).data;
export const releaseFilmForCustomerOrder = async (coId: number) =>
  (await apiClient.delete<{ released: number }>(`/film-reserve/customer-orders/${coId}`)).data;
export const releaseFilmReservation = async (id: number, note: string) =>
  (await apiClient.post<{ released: number }>(`/film-reserve/${id}/release`, { note })).data;
