import { useCallback, useState } from "react";

/** Состояние, которое помнит последний выбор на этом устройстве (20.10:
 * группировки, сортировка, галочки). Нет хранилища (приватное окно) —
 * работает как обычный useState. */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const full = `bdk:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(full);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(full, JSON.stringify(next));
        } catch {
          /* без хранилища — только в памяти */
        }
        return next;
      }),
    [full],
  );
  return [value, set];
}
