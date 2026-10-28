import { useEffect, useState } from "react";
import { Button, Card, Dropdown, Space, Tabs, Typography } from "antd";
import { hasPerm } from "../../auth/permissions";
import AreaRequestsPanel from "../../components/areaSupply/AreaRequestsPanel";
import AreaNormsPanel from "../../components/areaSupply/AreaNormsPanel";
import { useNavigate, useSearchParams } from "react-router-dom";
import CreateTaskModal from "./production/CreateTaskModal";
import OperationTaskModal from "./production/OperationTaskModal";
import PfSupplyModal from "./production/PfSupplyModal";
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
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  // новое задание участку (28.10) — здесь, а не в «Заказах на производство»:
  // это задание, а не заказ; ?new=1 — пришли оттуда по пункту меню
  const canManage = hasPerm(user, "production_tasks.manage");
  const [creating, setCreating] = useState<"film" | "ops" | null>(null);
  const [supply, setSupply] = useState<{ id: number; name: string } | null>(null);
  const wantNew = params.get("new") === "1";
  useEffect(() => {
    if (!wantNew) return;
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete("new");
      return n;
    }, { replace: true });
  }, [wantNew, setParams]);
  const [newOpen, setNewOpen] = useState(wantNew);
  const areas = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  // участок выдачи плёнки (15.10): его задания — доска выдачи
  const issuePoint = !!user?.area && !!areas.data?.find((a) => a.code === user.area)?.film_issue_point;
  // Выдача плёнки — задания участка выдачи (15.10): у его людей — «Мой
  // участок», у склада и начальника цеха — своя вкладка; мастерам — заявки
  // своего участка на склад (рулон, материал, п/ф).
  const seesBoard = hasPerm(user, "units.issue", "production_tasks.manage", "production_tasks.view");
  const canRequest = hasPerm(user, "production_tasks.report");
  const tab = params.get("tab");
  const issueTab =
    issuePoint
      ? null
      : seesBoard
        ? { key: "film-issue", label: "Выдача плёнки", children: <FilmIssueBoard /> }
        : canRequest
          ? {
              key: "film-issue",
              label: "Заявки на склад",
              children: (
                <Tabs
                  defaultActiveKey={params.get("sub") === "norms" ? "norms" : "requests"}
                  items={[
                    { key: "requests", label: "Заявки", children: <AreaRequestsPanel /> },
                    { key: "norms", label: "Неснижаемый остаток", children: <AreaNormsPanel /> },
                  ]}
                />
              ),
            }
          : null;
  const active =
    tab === "daily-sheet"
      ? "daily-sheet"
      : tab === "film-issue"
        ? issueTab
          ? "film-issue"
          : "daily-plan"
        : params.get("task") || tab === "tasks" || !user?.area
          ? "tasks"
          : "daily-plan";
  return (
    <Card>
      <Space style={{ width: "100%", justifyContent: "space-between" }} align="start">
        <Typography.Title level={4}>Задания цеха</Typography.Title>
        {canManage && (
          <Dropdown
            trigger={["click"]}
            open={newOpen}
            onOpenChange={setNewOpen}
            menu={{
              items: [
                { key: "film", label: "С плёнкой — окутка, ламинация: из наряда, плана заготовок или вручную…" },
                { key: "ops", label: "Без плёнки — работы участка по техкартам…" },
              ],
              onClick: ({ key }) => {
                setNewOpen(false);
                setCreating(key as "film" | "ops");
              },
            }}
          >
            <Button type="primary">Новое задание участку ▾</Button>
          </Dropdown>
        )}
      </Space>
      <Tabs
        key={`${params.get("task") ?? ""}:${params.get("tab") ?? ""}`}
        defaultActiveKey={active}
        items={[
          { key: "daily-plan", label: "Мой участок", children: issuePoint ? <FilmIssueBoard /> : <DailyPlanTab /> },
          {
            key: "tasks",
            label: "Задания",
            children: <TasksBoard />,
          },
          // бумажный дневной бланк линии/участка — из отчётов мастеров (06.10)
          { key: "daily-sheet", label: "Ежедневка", children: <DailySheet /> },
          ...(issueTab ? [issueTab] : []),
        ]}
      />
      <CreateTaskModal
        open={creating === "film"}
        onClose={() => setCreating(null)}
        onCreated={(t, needsPf) => {
          if (needsPf) setSupply({ id: t.id, name: t.name ?? "" });
          navigate(`/production-tasks?tab=tasks&task=${t.id}`);
        }}
      />
      <OperationTaskModal open={creating === "ops"} onClose={() => setCreating(null)} />
      {supply && <PfSupplyModal taskId={supply.id} taskName={supply.name} canManage={canManage} onClose={() => setSupply(null)} />}
    </Card>
  );
}
