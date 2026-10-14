import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { ConfigProvider } from "antd";
import ruRU from "antd/locale/ru_RU";
import dayjs from "dayjs";
import "dayjs/locale/ru";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import AppRoutes from "./routes";
import { theme } from "./theme";

// Даты и дни недели по-русски во всём приложении (DatePicker, «пн», «понедельник»).
dayjs.locale("ru");

// Отказ сервера 4xx (не найдено, нет прав, неверные данные) повтором не
// исправится — показываем сразу, а не после трёх повторов (14.10: страница
// несуществующего заказа ждала 7–10 с). Обрыв сети и 5xx — повторяем.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => {
        const st = (error as { response?: { status?: number } })?.response?.status;
        if (st && st >= 400 && st < 500) return false;
        return count < 3;
      },
    },
  },
});

// Offline-устойчивость (раздел про ускорение работы): TanStack Query уже
// по умолчанию ставит мутации на паузу при обрыве связи и продолжает их
// при восстановлении в рамках одной сессии страницы — это бесплатное
// поведение из коробки. Персист в localStorage добавляет к этому только
// одно: переживает ещё и перезагрузку/закрытие вкладки с ещё не
// отправленными действиями (например, обрыв Wi-Fi посреди сессии приёмки
// на складе) — персистим только незавершённые/приостановленные мутации,
// не обычный кэш запросов (он и так легко перезапрашивается заново).
const persister = createSyncStoragePersister({ storage: window.localStorage, key: "bdk-query-cache" });

export default function App() {
  return (
    <ConfigProvider locale={ruRU} theme={theme}>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: 24 * 60 * 60 * 1000,
          dehydrateOptions: {
            shouldDehydrateMutation: (mutation) => mutation.state.isPaused,
            shouldDehydrateQuery: () => false,
          },
        }}
      >
        <BrowserRouter>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </PersistQueryClientProvider>
    </ConfigProvider>
  );
}
