import { useMemo, useRef } from "react";

/** Ключ операции для защиты от повторной отправки (14.10, сервер —
 * core/idempotency.py): один на операцию, пока она не записана. Повтор
 * после обрыва сети уходит с тем же ключом — сервер не запишет второй раз,
 * а вернёт прежний ответ. После успеха — done(), следующая операция
 * получит новый ключ. scope — когда в форме несколько независимых
 * операций (строки быстрого отчёта): у каждой свой ключ. */
export function newOpKey(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* небезопасный контекст — ниже запасной вариант */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function useOpKeys() {
  const ref = useRef(new Map<string, string>());
  return useMemo(
    () => ({
      get(scope = "main"): string {
        let k = ref.current.get(scope);
        if (!k) {
          k = newOpKey();
          ref.current.set(scope, k);
        }
        return k;
      },
      done(scope = "main"): void {
        ref.current.delete(scope);
      },
    }),
    [],
  );
}

/** Заголовок для axios: `apiClient.post(url, body, opHeaders(key))`. */
export const opHeaders = (key?: string | null) => (key ? { headers: { "Idempotency-Key": key } } : undefined);
