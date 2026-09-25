import { Card, Tabs, Typography } from "antd";
import { useSearchParams } from "react-router-dom";
import DailyPlanTab from "./production/DailyPlanTab";
import TasksTab from "./production/TasksTab";
import RollReconciliationTab from "./production/RollReconciliationTab";

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
  // ?task=ID (сквозной поиск по номеру) — сразу «Все задания» с этим заданием.
  const [params] = useSearchParams();
  return (
    <Card>
      <Typography.Title level={4}>Производственные задания цеха</Typography.Title>
      <Tabs
        key={params.get("task") ?? "default"}
        defaultActiveKey={params.get("task") ? "tasks" : "daily-plan"}
        items={[
          { key: "daily-plan", label: "📅 План на день (Мастер)", children: <DailyPlanTab /> },
          { key: "tasks", label: "📋 Все задания", children: <TasksTab /> },
          { key: "reconciliation", label: "🧵 Сверка рулонов", children: <RollReconciliationTab /> },
        ]}
      />
    </Card>
  );
}
