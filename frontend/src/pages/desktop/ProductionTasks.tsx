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
const ProductionMonitor = lazyPage(() => import("./production/ProductionMonitor"));
const Demand = lazyPage(() => import("./production/Demand"));

/** Производственный Хаб (APS & Shop Floor) — единое рабочее место управления цехом.
 * Объединяет:
 * - Мой участок и смену (быстрая сдача, планшет мастера, Smart Batching);
 * - Реестр заданий цеха;
 * - Монитор готовности (сквозная шахматка по участкам);
 * - Планирование (планировщик по дням и производственный календарь);
 * - Потребность и дефицит сырья (MRP);
 * - Выдачу плёнки и заявки на склад. */
export default function ProductionTasks() {
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const canManage = hasPerm(user, "production_tasks.manage");
  const canMonitor = hasPerm(user, "production_tasks.manage", "production_tasks.view", "reports.view");
  const canDemand = hasPerm(user, "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view");

  const [creating, setCreating] = useState<"film" | "ops" | null>(null);
  const [supply, setSupply] = useState<{ id: number; name: string } | null>(null);

  const wantNew = params.get("new") === "1";
  useEffect(() => {
    if (!wantNew) return;
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete("new");
        return n;
      },
      { replace: true }
    );
  }, [wantNew, setParams]);

  const [newOpen, setNewOpen] = useState(wantNew);
  const areas = useQuery({ queryKey: ["areas"], queryFn: listAreas });

  // Участок выдачи плёнки
  const issuePoint = !!user?.area && !!areas.data?.find((a) => a.code === user.area)?.film_issue_point;
  const seesBoard = hasPerm(user, "units.issue", "production_tasks.manage", "production_tasks.view");
  const canRequest = hasPerm(user, "production_tasks.report");

  const issueTab = issuePoint
    ? null
    : seesBoard
      ? { key: "film-issue", label: "🚚 Выдача плёнки", children: <FilmIssueBoard /> }
      : canRequest
        ? {
            key: "film-issue",
            label: "📦 Заявки на склад",
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

  const tab = params.get("tab");

  const tabItems = [
    {
      key: "daily-plan",
      label: "🏭 Мой участок",
      children: issuePoint ? <FilmIssueBoard /> : <DailyPlanTab />,
    },
    {
      key: "tasks",
      label: "📋 Задания",
      children: <TasksBoard />,
    },
    ...(canMonitor
      ? [
          {
            key: "monitor",
            label: "📊 Монитор готовности",
            children: <ProductionMonitor />,
          },
        ]
      : []),
    ...(canDemand
      ? [
          {
            key: "demand",
            label: "⚡ Потребность (MRP)",
            children: <Demand />,
          },
        ]
      : []),
    ...(issueTab ? [issueTab] : []),
    {
      key: "daily-sheet",
      label: "📝 Ежедневка",
      children: <DailySheet />,
    },
  ];

  const active =
    tab && tabItems.some((t) => t.key === tab)
      ? tab
      : params.get("task") || !user?.area
        ? "tasks"
        : "daily-plan";

  const onTabChange = (key: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", key);
        return next;
      },
      { replace: true }
    );
  };

  return (
    <Card
      size="small"
      style={{ borderRadius: 8, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}
      styles={{ body: { padding: "12px 16px" } }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Space align="center" size={8}>
          <span style={{ fontSize: 18 }}>🏭</span>
          <Typography.Title level={4} style={{ margin: 0, whiteSpace: "nowrap" }}>
            Производство
          </Typography.Title>
        </Space>

        {canManage && (
          <Dropdown
            trigger={["click"]}
            open={newOpen}
            onOpenChange={setNewOpen}
            menu={{
              items: [
                {
                  key: "film",
                  label: "С плёнкой — окутка, ламинация: из наряда, плана заготовок или вручную…",
                },
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
      </div>

      <Tabs
        activeKey={active}
        onChange={onTabChange}
        items={tabItems}
        destroyOnHidden
      />

      <CreateTaskModal
        open={creating === "film"}
        onClose={() => setCreating(null)}
        onCreated={(t, needsPf) => {
          if (needsPf) setSupply({ id: t.id, name: t.name ?? "" });
          navigate(`/production-tasks?tab=tasks&task=${t.id}`);
        }}
      />
      <OperationTaskModal
        open={creating === "ops"}
        onClose={() => setCreating(null)}
      />
      {supply && (
        <PfSupplyModal
          taskId={supply.id}
          taskName={supply.name}
          canManage={canManage}
          onClose={() => setSupply(null)}
        />
      )}
    </Card>
  );
}
