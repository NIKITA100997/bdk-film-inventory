import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import Overview from "./desktop/Overview";

// Обзор (5.5 ТЗ) — единая посадочная страница на "/" для всех ролей (8.2
// раздел бэклога доработок: один пункт "Обзор" в едином дереве, не два
// разных входа для десктопных/складских ролей). Overview.tsx сам решает,
// какие карточки показать конкретной роли, и молчит, если нечего показать.
// Мастер (участок закреплён, отчитывается о производстве) — сразу в «Мой
// участок»: на «Обзоре» ему делать нечего (30.09, проверка с планшета).
export default function Home() {
  const { user } = useAuth();
  const reports = !!user?.permissions.includes("production_tasks.report");
  if (user && !user.is_superuser && user.area && reports) return <Navigate to="/production-tasks" replace />;
  return <Overview />;
}
