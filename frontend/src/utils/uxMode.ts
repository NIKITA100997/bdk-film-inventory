import type { CurrentUser } from "../auth/types";

export type UxMode = "terminal" | "office";

const UX_MODE_KEY = "bdk-ux-mode";

const OFFICE_PERMS = new Set([
  "reports.view",
  "purchasing.manage",
  "plan.approve",
  "users.manage",
  "materials.manage",
  "sales_calculator.view",
]);

const TERMINAL_PERMS = new Set([
  "units.receive",
  "units.issue",
  "units.return",
  "production_tasks.report",
  "part_units.manage",
]);

/** Определяет, является ли роль пользователя цеховой/складской по умолчанию. */
export function isTerminalRole(user: CurrentUser | null | undefined): boolean {
  if (!user) return false;
  const perms = new Set(user.permissions ?? []);
  if (perms.has("*")) return false;
  for (const p of OFFICE_PERMS) {
    if (perms.has(p)) return false;
  }
  for (const p of TERMINAL_PERMS) {
    if (perms.has(p)) return true;
  }
  return false;
}

export function getStoredUxMode(): UxMode | null {
  try {
    const val = localStorage.getItem(UX_MODE_KEY);
    return val === "terminal" || val === "office" ? val : null;
  } catch {
    return null;
  }
}

export function getEffectiveUxMode(user: CurrentUser | null | undefined): UxMode {
  return getStoredUxMode() ?? (isTerminalRole(user) ? "terminal" : "office");
}

export function setStoredUxMode(mode: UxMode | null): void {
  try {
    if (mode) {
      localStorage.setItem(UX_MODE_KEY, mode);
    } else {
      localStorage.removeItem(UX_MODE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}
