import { Card, Tabs, Typography } from "antd";
import DailyPlanTab from "./production/DailyPlanTab";
import TasksTab from "./production/TasksTab";

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
  return (
    <Card>
      <Typography.Title level={4}>Производственные задания цеха</Typography.Title>
      <Tabs
        items={[
          { key: "daily-plan", label: "📅 План на день (Мастер)", children: <DailyPlanTab /> },
          { key: "tasks", label: "📋 Все задания (Неделя)", children: <TasksTab /> },
        ]}
      />
    </Card>
  );
}
