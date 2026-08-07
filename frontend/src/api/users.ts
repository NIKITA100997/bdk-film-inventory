import { apiClient } from "./client";
import type { Area, UserRole } from "../auth/types";

export interface UserSummary {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  area: Area | null;
  is_active: boolean;
}

export async function listUsers(): Promise<UserSummary[]> {
  const { data } = await apiClient.get<UserSummary[]>("/auth/users");
  return data;
}
