import { Alert } from "antd";
import { useMutationState } from "@tanstack/react-query";
import { useOnlineStatus } from "../hooks/useOnlineStatus";

/** Offline-устойчивость (раздел про ускорение работы) — при обрыве Wi-Fi на
 * складе действия (приёмка, выдача...) не теряются: TanStack Query ставит
 * их мутации на паузу и повторяет при восстановлении связи (см. App.tsx).
 * Баннер даёт видимую обратную связь, что происходящее не "зависло". */
export default function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const pausedCount = useMutationState({
    filters: { status: "pending" },
    select: (mutation) => mutation.state,
  }).filter((m) => m.isPaused).length;

  if (isOnline && pausedCount === 0) return null;

  return (
    <Alert
      type="warning"
      showIcon
      banner
      message={
        !isOnline
          ? pausedCount > 0
            ? `Нет соединения — отложено действий: ${pausedCount}. Отправим, как только связь восстановится.`
            : "Нет соединения с сервером — действия будут отправлены при восстановлении связи."
          : `Связь восстановлена — отправляем отложенные действия: ${pausedCount}…`
      }
    />
  );
}
