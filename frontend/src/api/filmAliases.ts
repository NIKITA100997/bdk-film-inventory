import { apiClient } from "./client";

/** Сопоставление «текст из внешнего источника → плёнка справочника» —
 * общее для всей программы (графики запуска, наряды, планы заготовок). */
export interface FilmAlias {
  id: number;
  text: string;
  film: string;
  material_sku_id: number | null;
  any_thickness: boolean;
  source: string | null;
  has_stock_sku: boolean;
}

export interface FilmAliasInput {
  text: string;
  material_sku_id: number;
  any_thickness?: boolean;
  source?: string | null;
}

export const listFilmAliases = async (): Promise<FilmAlias[]> => (await apiClient.get<FilmAlias[]>("/film-aliases")).data;
export const createFilmAlias = async (p: FilmAliasInput): Promise<FilmAlias> => (await apiClient.post<FilmAlias>("/film-aliases", p)).data;
export const updateFilmAlias = async (id: number, p: FilmAliasInput): Promise<FilmAlias> =>
  (await apiClient.patch<FilmAlias>(`/film-aliases/${id}`, p)).data;
export const deleteFilmAlias = async (id: number): Promise<void> => {
  await apiClient.delete(`/film-aliases/${id}`);
};
