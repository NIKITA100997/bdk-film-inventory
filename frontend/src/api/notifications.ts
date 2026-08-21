import { apiClient } from "./client";

export interface Notification {
  id: number;
  signal_type: string;
  entity_id: number;
  title: string;
  detail: string | null;
  first_seen_at: string;
  read_at: string | null;
  is_new: boolean;
}

export const listNotifications = async (): Promise<Notification[]> =>
  (await apiClient.get<Notification[]>("/notifications")).data;

export const markNotificationRead = async (id: number): Promise<Notification> =>
  (await apiClient.post<Notification>(`/notifications/${id}/read`)).data;
