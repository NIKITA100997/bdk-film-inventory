import { Card, Tabs, Typography } from "antd";
import { useSearchParams } from "react-router-dom";
import DailyPlanTab from "./production/DailyPlanTab";
import TasksBoard from "./production/TasksBoard";
import DailySheet from "./production/DailySheet";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { listAreas } from "../../api/areas";
import { lazyPage } from "../../utils/lazyPage";

const FilmIssueBoard = lazyPage(() => import("./FilmIssueBoard"));

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
  const areas = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  // участок выдачи плёнки (15.10): его задания — доска выдачи
  const issuePoint = !!user?.area && !!areas.data?.find((a) => a.code === user.area)?.film_issue_point;
  return (
    <Card>
      <Typography.Title level={4}>Задания цеха</Typography.Title>
      <Tabs
        key={`${params.get("task") ?? ""}:${params.get("tab") ?? ""}`}
        defaultActiveKey={params.get("tab") === "daily-sheet" ? "daily-sheet" : params.get("task") || params.get("tab") === "tasks" || !user?.area ? "tasks" : "daily-plan"}
        items={[
          { key: "daily-plan", label: "Мой участок", children: issuePoint ? <FilmIssueBoard /> : <DailyPlanTab /> },
          {
            key: "tasks",
            label: "Задания",
            children: <TasksBoard />,
          },
          // бумажный дневной бланк линии/участка — из отчётов мастеров (06.10)
          { key: "daily-sheet", label: "Ежедневка", children: <DailySheet /> },
        ]}
      />
    </Card>
  );
}
