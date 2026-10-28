import { apiClient } from "./client";

/** «Ждёт меня» (28.10): что ждёт действия пользователя — по его правам. */
export interface InboxItem {
  key: string;
  title: string;
  count: number;
  link: string;
  hint: string | null;
  level: "urgent" | "normal";
}

export const getInbox = async (): Promise<InboxItem[]> => (await apiClient.get<InboxItem[]>("/inbox")).data;
