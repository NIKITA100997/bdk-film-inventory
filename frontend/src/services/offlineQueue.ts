import { useState, useEffect, useCallback, useRef } from "react";
import { message } from "antd";
import { apiClient } from "../api/client";
import { newOpKey } from "../utils/opKey";

export interface QueuedOfflineAction {
  id: string;
  createdAt: string;
  endpoint: string;
  method: "POST" | "PATCH" | "PUT";
  payload: unknown;
  title: string;
  opKey: string;
  retryCount: number;
  lastError?: string;
}

const STORAGE_KEY = "bdk_offline_reports_queue_v1";
export const OFFLINE_QUEUE_EVENT = "bdk:offline-queue-changed";

export function getOfflineQueue(): QueuedOfflineAction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedOfflineAction[];
  } catch (err) {
    console.error("Ошибка чтения офлайн-очереди:", err);
    return [];
  }
}

function saveOfflineQueue(queue: QueuedOfflineAction[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    window.dispatchEvent(new CustomEvent(OFFLINE_QUEUE_EVENT, { detail: { count: queue.length } }));
  } catch (err) {
    console.error("Ошибка сохранения офлайн-очереди:", err);
  }
}

/**
 * Сохранить действие (отчёт о производстве или сверку пула) в офлайн-буфер при отсутствии сети.
 */
export function enqueueOfflineAction(action: {
  endpoint: string;
  method?: "POST" | "PATCH" | "PUT";
  payload: unknown;
  title: string;
  opKey?: string;
}): QueuedOfflineAction {
  const queue = getOfflineQueue();
  const id = `off-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const item: QueuedOfflineAction = {
    id,
    createdAt: new Date().toISOString(),
    endpoint: action.endpoint,
    method: action.method || "POST",
    payload: action.payload,
    title: action.title,
    opKey: action.opKey || newOpKey(),
    retryCount: 0,
  };

  queue.push(item);
  saveOfflineQueue(queue);

  message.warning({
    content: `Связь с сервером отсутствует. «${action.title}» сохранён в памяти планшета и будет передан автоматически при появлении сети.`,
    duration: 6,
  });

  return item;
}

export function removeOfflineAction(id: string) {
  const queue = getOfflineQueue().filter((item) => item.id !== id);
  saveOfflineQueue(queue);
}

export function clearOfflineQueue() {
  saveOfflineQueue([]);
}

let isSyncingGlobal = false;

/**
 * Отправить накопленные в офлайн-буфере отчёты на сервер по очереди (FIFO).
 */
export async function syncOfflineQueue(
  onProgress?: (left: number) => void,
): Promise<{ succeeded: number; failed: number; remaining: number }> {
  if (isSyncingGlobal) {
    return { succeeded: 0, failed: 0, remaining: getOfflineQueue().length };
  }

  const queue = getOfflineQueue();
  if (queue.length === 0) {
    return { succeeded: 0, failed: 0, remaining: 0 };
  }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { succeeded: 0, failed: 0, remaining: queue.length };
  }

  isSyncingGlobal = true;
  let succeeded = 0;
  let failed = 0;

  try {
    // Делаем копию очереди, чтобы обрабатывать по порядку
    const items = [...queue];

    for (const item of items) {
      try {
        await apiClient.request({
          url: item.endpoint,
          method: item.method,
          data: item.payload,
          headers: {
            "Idempotency-Key": item.opKey,
          },
        });

        // Успешно отправлен
        succeeded++;
        removeOfflineAction(item.id);
        if (onProgress) onProgress(getOfflineQueue().length);
      } catch (err: any) {
        const status = err.response?.status;

        // Если это ошибка валидации данных или закрытый период — удаляем, чтобы не блокировать очередь бесконечно
        if (status && status >= 400 && status < 500) {
          failed++;
          const detail = err.response?.data?.detail || err.message;
          console.warn(`Офлайн-отчёт ${item.id} отклонён сервером (${status}):`, detail);
          removeOfflineAction(item.id);
          message.error(`Отчёт «${item.title}» отклонён: ${detail}`);
        } else {
          // Сетевая ошибка или сбой сервера (500/502/503/timeout) — прерываем цикл синхронизации, повторим позже
          console.warn("Синхронизация прервана из-за недоступности сервера:", err.message);
          item.retryCount = (item.retryCount || 0) + 1;
          item.lastError = err.message;
          saveOfflineQueue(getOfflineQueue());
          break;
        }
      }
    }

    if (succeeded > 0) {
      const left = getOfflineQueue().length;
      if (left === 0) {
        message.success(`Связь восстановлена! Все отчёты (${succeeded} шт.) успешно переданы на сервер.`);
      } else {
        message.info(`Передано отчётов: ${succeeded}. Осталось в очереди: ${left}.`);
      }
    }
  } finally {
    isSyncingGlobal = false;
  }

  return { succeeded, failed, remaining: getOfflineQueue().length };
}

/**
 * Проверить, является ли ошибка ошибкой сети / обрывом связи (для автоматического помещения в офлайн-буфер).
 */
export function isNetworkError(error: any): boolean {
  if (!error) return false;
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (error.code === "ERR_NETWORK" || error.code === "ECONNABORTED") return true;
  if (!error.response && error.message && error.message.toLowerCase().includes("network")) return true;
  if (error.response?.status === 502 || error.response?.status === 503 || error.response?.status === 504) return true;
  return false;
}

/**
 * React-хук состояния офлайн-буфера и статуса сети.
 */
export function useOfflineQueue() {
  const [queue, setQueue] = useState<QueuedOfflineAction[]>(getOfflineQueue);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    setQueue(getOfflineQueue());
  }, []);

  const triggerSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      await syncOfflineQueue();
      refresh();
    } finally {
      setIsSyncing(false);
    }
  }, [refresh]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // При появлении сети запускаем синхронизацию с небольшой задержкой (чтобы соединение стабилизировалось)
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = setTimeout(() => {
        triggerSync();
      }, 1500);
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    const handleQueueChange = () => {
      refresh();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener(OFFLINE_QUEUE_EVENT, handleQueueChange);

    // Периодическая проверка раз в 30 секунд, если в очереди есть элементы
    const interval = setInterval(() => {
      if (navigator.onLine && getOfflineQueue().length > 0 && !isSyncingGlobal) {
        triggerSync();
      }
    }, 30000);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener(OFFLINE_QUEUE_EVENT, handleQueueChange);
      clearInterval(interval);
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    };
  }, [refresh, triggerSync]);

  return {
    queue,
    queueCount: queue.length,
    isOnline,
    isSyncing,
    syncNow: triggerSync,
    clearAll: () => {
      clearOfflineQueue();
      refresh();
    },
  };
}
