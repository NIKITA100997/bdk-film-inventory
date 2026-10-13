/** Проверка прав на экранах (13.10) — одна функция вместо ручного
 * «is_superuser || permissions.includes(…)» в каждом экране: суперпользователь
 * может всё, остальные — если есть хоть одно из прав. */
export function hasPerm(user: { is_superuser?: boolean; permissions: string[] } | null | undefined, ...codes: string[]): boolean {
  if (!user) return false;
  return !!user.is_superuser || codes.some((c) => user.permissions.includes(c));
}
