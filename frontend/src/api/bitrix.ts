import { apiClient } from "./client";

/** Битрикс24 (12.10): настройки вебхука, чаты, сотрудники, журнал сообщений. */
export interface BitrixSettings {
  enabled: boolean;
  webhook: string | null;
  webhook_set?: boolean;
  base_url: string | null;
  chat_production: string | null;
  chat_logistics: string | null;
  chat_purchasing: string | null;
  purchaser: number | null;
}
export interface BitrixChat { dialog_id: string; title: string }
export interface BitrixUser { id: number; name: string; email: string | null }
export interface UserMapRow { user_id: number; full_name: string; bitrix_user_id: number | null }
export interface OutboxRow { id: number; event: string; status: string; error: string | null; text: string; created_at: string }

export const getBitrixSettings = async () => (await apiClient.get<BitrixSettings>("/bitrix/settings")).data;
export const saveBitrixSettings = async (s: BitrixSettings) => (await apiClient.put<BitrixSettings>("/bitrix/settings", s)).data;
export const testBitrix = async (dialogId?: string | null) =>
  (await apiClient.post<{ ok: boolean; name: string }>("/bitrix/test", { dialog_id: dialogId ?? null })).data;
export const listBitrixChats = async () => (await apiClient.get<BitrixChat[]>("/bitrix/chats")).data;
export const listBitrixUsers = async () => (await apiClient.get<BitrixUser[]>("/bitrix/users")).data;
export const getUserMap = async () => (await apiClient.get<UserMapRow[]>("/bitrix/user-map")).data;
export const saveUserMap = async (rows: { user_id: number; bitrix_user_id: number | null }[]) =>
  (await apiClient.put<UserMapRow[]>("/bitrix/user-map", rows)).data;
export const listOutbox = async () => (await apiClient.get<OutboxRow[]>("/bitrix/outbox")).data;
export const retryOutbox = async (id: number) => (await apiClient.post(`/bitrix/outbox/${id}/retry`)).data;
