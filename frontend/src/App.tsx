import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { ConfigProvider } from "antd";
import ruRU from "antd/locale/ru_RU";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import AppRoutes from "./routes";
import { theme } from "./theme";

const queryClient = new QueryClient();

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
