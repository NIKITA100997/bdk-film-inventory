import { apiClient } from "./client";

// Пометка совместимости партии п/ф с определённым видом плёнки для
// окутки ("ламис"/"с кромкой"/"аляска" и т.п.) — управляемый справочник,
// список будет расширяться. Только видимая пометка на партии, не
// участвует в подборе по FIFO.
export interface PartFilmRestriction {
  code: string;
  name: string;
  is_active: boolean;
}

export const listPartFilmRestrictions = async (): Promise<PartFilmRestriction[]> =>
  (await apiClient.get<PartFilmRestriction[]>("/part-film-restrictions")).data;

export const createPartFilmRestriction = async (name: string): Promise<PartFilmRestriction> =>
  (await apiClient.post<PartFilmRestriction>("/part-film-restrictions", { name })).data;
