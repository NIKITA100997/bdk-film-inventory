import { apiClient } from "./client";

/** «Общее» (28.10): набор модулей главной у пользователя; null — стандартный по ролям. */
export const getHomeModules = async (): Promise<string[] | null> => (await apiClient.get<{ modules: string[] | null }>("/home")).data.modules;
export const setHomeModules = async (modules: string[] | null): Promise<string[] | null> =>
  (await apiClient.put<{ modules: string[] | null }>("/home", { modules })).data.modules;
