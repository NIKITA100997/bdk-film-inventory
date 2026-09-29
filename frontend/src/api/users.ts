import { apiClient } from "./client";
import type { Area, RoleSummary } from "../auth/types";

export interface UserSummary {
  id: number;
  username: string;
  full_name: string;
  roles: RoleSummary[];
  is_superuser: boolean;
  area: Area | null;
  is_active: boolean;
  must_change_password?: boolean;
  /** «Забыл пароль» на экране входа — ждёт сброса администратором. */
  password_reset_requested_at?: string | null;
}

export async function listUsers(): Promise<UserSummary[]> {
  const { data } = await apiClient.get<UserSummary[]>("/auth/users");
  return data;
}

export interface UserCreatePayload {
  username: string;
  full_name: string;
  role_ids: number[];
  is_superuser?: boolean;
  area?: Area | null;
  password?: string;
}

export interface UserCreateResult {
  user: UserSummary;
  temporary_password: string;
}

export interface UserUpdatePayload {
  full_name?: string;
  role_ids?: number[];
  is_superuser?: boolean;
  area?: Area | null;
  is_active?: boolean;
}

export async function listAllUsers(): Promise<UserSummary[]> {
  const { data } = await apiClient.get<UserSummary[]>("/users");
  return data;
}

export async function createUser(payload: UserCreatePayload): Promise<UserCreateResult> {
  const { data } = await apiClient.post<UserCreateResult>("/users", payload);
  return data;
}

export async function updateUser(id: number, payload: UserUpdatePayload): Promise<UserSummary> {
  const { data } = await apiClient.patch<UserSummary>(`/users/${id}`, payload);
  return data;
}

/** Администратор задаёт пароль сам; mustChange — сменить при первом входе. */
export async function setUserPassword(id: number, password: string, mustChange: boolean): Promise<void> {
  await apiClient.post(`/users/${id}/set-password`, { password, must_change: mustChange });
}

export async function resetUserPassword(id: number): Promise<{ temporary_password: string }> {
  const { data } = await apiClient.post<{ temporary_password: string }>(`/users/${id}/reset-password`);
  return data;
}
