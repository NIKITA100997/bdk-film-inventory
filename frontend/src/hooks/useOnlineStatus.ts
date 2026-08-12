import { useEffect, useState } from "react";
import { onlineManager } from "@tanstack/react-query";

/** Обёртка над onlineManager из TanStack Query — он уже отслеживает
 * online/offline через браузерные события, не дублируем эту логику. */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(onlineManager.isOnline());

  useEffect(() => onlineManager.subscribe(() => setIsOnline(onlineManager.isOnline())), []);

  return isOnline;
}
