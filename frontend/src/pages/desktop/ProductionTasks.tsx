import { useEffect, useState } from "react";
import { Button, Card, Dropdown, Space, Tabs, Typography } from "antd";
import { hasPerm } from "../../auth/permissions";
import { useNavigate, useSearchParams } from "react-router-dom";
import CreateTaskModal from "./production/CreateTaskModal";
import OperationTaskModal from "./production/OperationTaskModal";
import PfSupplyModal from "./production/PfSupplyModal";
import DailyPlanTab from "./production/DailyPlanTab";
import { useAuth } from "../../auth/AuthContext";
import { lazyPage } from "../../utils/lazyPage";
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
    if (params.get("tab") !== "film-issue") return;
    const oldSupplyTab = params.get("sub");
    if (oldSupplyTab === "requests" || oldSupplyTab === "norms") {
      navigate(`/stock?tab=requests&sub=${oldSupplyTab}`, { replace: true });
      return;
    }
    const next = new URLSearchParams(params);
    next.set("tab", "plan");
    navigate(`/film-operations?${next.toString()}`, { replace: true });
  }, [params, navigate]);

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

  // Перенаправление со старых вкладок (orders, tasks, daily-sheet, pick-route) в 3 ключевые
  useEffect(() => {
    const curTab = params.get("tab");
    if (curTab === "orders" || curTab === "tasks") {
      const next = new URLSearchParams(params);
      next.set("tab", "monitor");
      navigate(`/production-tasks?${next.toString()}`, { replace: true });
    } else if (curTab === "daily-sheet") {
      const next = new URLSearchParams(params);
      next.set("tab", "daily-plan");
      navigate(`/production-tasks?${next.toString()}`, { replace: true });
    } else if (curTab === "pick-route") {
      const next = new URLSearchParams(params);
      next.set("tab", "demand");
      navigate(`/production-tasks?${next.toString()}`, { replace: true });
    }
  }, [params, navigate]);

  const [newOpen, setNewOpen] = useState(wantNew);
  const tab = params.get("tab");

  const tabItems = [
    ...(canMonitor
      ? [
          {
            key: "monitor",
            label: "📊 Монитор производства",
            children: <ProductionMonitor />,
          },
        ]
      : []),
    {
      key: "daily-plan",
      label: user?.area ? "📍 Мой участок" : "🏭 Мой участок",
      children: <DailyPlanTab />,
    },
    ...(canDemand
      ? [
          {
            key: "demand",
            label: "⚡ Потребность (MRP)",
            children: <Demand />,
          },
        ]
      : []),
  ];

  const active =
    tab && tabItems.some((t) => t.key === tab)
      ? tab
      : user?.area
        ? "daily-plan"
        : canMonitor
          ? "monitor"
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

        <Space size={8} wrap>
          {hasPerm(user, "part_units.count", "production_tasks.manage", "inventory.manage") && (
            <Button onClick={() => navigate("/inventory?place_type=area")}>
              🔄 Пересчёт участка
            </Button>
          )}
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
        </Space>
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
          navigate(`/production-tasks?tab=monitor&task=${t.id}`);
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
