import { apiClient } from "./client";
import type { SystemRoleCode } from "../auth/types";

export interface PermissionSummary {
  id: number;
  code: string;
  name: string;
  section: string;
}

export interface Role {
  id: number;
  code: SystemRoleCode | null;
  name: string;
  is_active: boolean;
  permissions: PermissionSummary[];
}

export async function listRoles(): Promise<Role[]> {
  const { data } = await apiClient.get<Role[]>("/roles");
  return data;
}

export async function createRole(name: string): Promise<Role> {
  const { data } = await apiClient.post<Role>("/roles", { name });
  return data;
}

export async function updateRole(id: number, payload: { name?: string; is_active?: boolean }): Promise<Role> {
  const { data } = await apiClient.patch<Role>(`/roles/${id}`, payload);
  return data;
}

export async function updateRolePermissions(id: number, permissionIds: number[]): Promise<Role> {
  const { data } = await apiClient.put<Role>(`/roles/${id}/permissions`, { permission_ids: permissionIds });
  return data;
}

export async function listPermissions(): Promise<PermissionSummary[]> {
  const { data } = await apiClient.get<PermissionSummary[]>("/permissions");
  return data;
}
