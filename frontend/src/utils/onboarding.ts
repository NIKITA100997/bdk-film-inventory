const KEY_PREFIX = "bdk:onboarding-seen:";

/** "Просмотрено" — состояние конкретного пользователя, не устройства:
 * планшет на складе используется посменно разными людьми (в отличие от
 * черновика формы в useDraftForm.ts, здесь ключ обязательно с userId). */
export function isOnboardingSeen(userId: number): boolean {
  return localStorage.getItem(KEY_PREFIX + userId) === "1";
}

export function markOnboardingSeen(userId: number): void {
  localStorage.setItem(KEY_PREFIX + userId, "1");
}
