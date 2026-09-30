import { useState } from "react";
import { Card, Segmented, Space, Tabs, Typography } from "antd";
import { useSearchParams } from "react-router-dom";
import DailyPlanTab from "./production/DailyPlanTab";
import TasksTab from "./production/TasksTab";
import TasksBoard from "./production/TasksBoard";
import { useAuth } from "../../auth/AuthContext";
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
  // ?task=ID (сквозной поиск по номеру) — сразу вкладка «Задания» с этим заданием.
  const [params] = useSearchParams();
  const { user } = useAuth();
  // Мастер (участок закреплён) начинает со своего участка, начальник — со списка заданий.
  const [view, setView] = useState<"board" | "table">(() => {
    try {
      return (localStorage.getItem("tasks-view") as "board" | "table") || "board";
    } catch {
      return "board";
    }
  });
  const pickView = (v: "board" | "table") => {
    setView(v);
    try {
      localStorage.setItem("tasks-view", v);
    } catch {
      /* не запоминаем */
    }
  };
  return (
    <Card>
      <Typography.Title level={4}>Задания цеха</Typography.Title>
      <Tabs
        key={params.get("task") ?? "default"}
        defaultActiveKey={params.get("task") || !user?.area ? "tasks" : "daily-plan"}
        items={[
          { key: "daily-plan", label: "Мой участок", children: <DailyPlanTab /> },
          {
            key: "tasks",
            label: "Задания",
            children: (
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                <Segmented
                  value={view}
                  onChange={(v) => pickView(v as "board" | "table")}
                  options={[
                    { value: "board", label: "Список и карточка" },
                    { value: "table", label: "Таблица (как раньше)" },
                  ]}
                />
                {view === "board" ? <TasksBoard /> : <TasksTab />}
              </Space>
            ),
          },
          { key: "reconciliation", label: "Сверка рулонов", children: <RollReconciliationTab /> },
        ]}
      />
    </Card>
  );
}
