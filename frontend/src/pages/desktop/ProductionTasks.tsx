import { Card, Tabs, Typography } from "antd";
import { useSearchParams } from "react-router-dom";
import DailyPlanTab from "./production/DailyPlanTab";
import TasksBoard from "./production/TasksBoard";
import { useAuth } from "../../auth/AuthContext";

/** Задания — разбор «N штук модели X» на строки по производственным
 * линиям (пилот: окутка царговых). Начальник участка (есть свой user.area)
 * видит только задания своего участка — тот же принцип, что уже в
 * MaterialsExplorer/Overview для остальных area-скоупированных экранов.
 *
 * Раздел 16 бэклога доработок — этот файл раньше был 889 строк одним
 * компонентом (список заданий + создание + распределение по линиям +
 * отчёт о браке, всё через вложенные модалки). Разбит на отдельные
 * компоненты в ./production/ — каждый сам тянет нужные данные по своим
 * query-ключам (кэш React Query общий, лишних запросов не добавляет). */
export default function ProductionTasks() {
  // ?task=ID (сквозной поиск по номеру) — сразу вкладка «Задания» с этим заданием.
  const [params] = useSearchParams();
  const { user } = useAuth();
  return (
    <Card>
      <Typography.Title level={4}>Задания цеха</Typography.Title>
      <Tabs
        key={`${params.get("task") ?? ""}:${params.get("tab") ?? ""}`}
        defaultActiveKey={params.get("task") || params.get("tab") === "tasks" || !user?.area ? "tasks" : "daily-plan"}
        items={[
          { key: "daily-plan", label: "Мой участок", children: <DailyPlanTab /> },
          {
            key: "tasks",
            label: "Задания",
            children: <TasksBoard />,
          },
        ]}
      />
    </Card>
  );
}
