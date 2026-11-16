import { useState, useRef, useCallback } from "react";

/**
 * Хук для защиты от случайного двойного клика (двойного сабмита) на сенсорных экранах и при сетевых задержках.
 * Блокирует повторные вызовы до завершения асинхронной операции + дополнительный cooldown (по умолчанию 800 мс).
 */
export function useDoubleSubmitGuard<T extends (...args: any[]) => Promise<any>>(
  action: T,
  cooldownMs = 800,
) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isLockedRef = useRef(false);

  const guardedAction = useCallback(
    async (...args: Parameters<T>): Promise<ReturnType<T> | undefined> => {
      if (isLockedRef.current) {
        console.warn("Повторное нажатие заблокировано защитой от двойного сабмита");
        return undefined;
      }

      isLockedRef.current = true;
      setIsSubmitting(true);

      try {
        const result = await action(...args);
        return result;
      } finally {
        setTimeout(() => {
          isLockedRef.current = false;
          setIsSubmitting(false);
        }, cooldownMs);
      }
    },
    [action, cooldownMs],
  );

  return {
    isSubmitting,
    guardedAction,
  };
}
