import { apiClient } from "./client";

/** Доска выдачи плёнки (15.10): что нужно по заданиям, что выдано, что
 * покрыто остатком на участке, что ещё выдать; рулоны на участках; Фабрика. */
export type FilmIssueStatus = "issued" | "covered" | "partial" | "none" | "site_stock";

export interface FilmIssueLine {
  task_id: number;
  task_name: string;
  order_name: string | null;
  line_id: number;
  part_name: string | null;
  film: string;
  spec_key: string;
  strip_width_mm: number;
  quantity_pieces: number;
  produced_pieces: number;
  need_m: number;
  issued_m: number;
  covered_by_area_m: number;
  to_issue_m: number;
  to_issue_m2: number;
  need_by: string | null;
  status: FilmIssueStatus;
}

export interface FilmIssueArea {
  area: string;
  area_name: string;
  site: string | null;
  lines: FilmIssueLine[];
}

export interface AreaRoll {
  unit_id: number;
  area: string;
  area_name: string;
  film: string;
  spec_key: string;
  width_mm: number;
  remaining_m: number;
  remaining_m2: number;
  is_strip: boolean;
  issued_at: string | null;
  task_name: string | null;
  leftover: boolean;
}

export interface SiteStock {
  spec_key: string;
  film: string;
  need_m2: number;
  free_stock_m2: number;
  to_transfer_m2: number;
}

export interface FilmIssueBoard {
  areas: FilmIssueArea[];
  rolls_on_areas: AreaRoll[];
  fabrika: SiteStock[];
}

export const getFilmIssueBoard = async (): Promise<FilmIssueBoard> => (await apiClient.get<FilmIssueBoard>("/film-issue/board")).data;
