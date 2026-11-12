import { Button, Card, Space, Tabs } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { hasPerm } from "../../auth/permissions";
import { lazyPage } from "../../utils/lazyPage";

const FilmIssueBoard = lazyPage(() => import("./FilmIssueBoard"));
const FilmReconciliationPanel = lazyPage(() => import("./FilmReconciliationPanel"));
const IssueHub = lazyPage(() => import("../mobile/StockOpsHub").then((m) => ({ default: m.IssueHub })));
const ReceiveHub = lazyPage(() => import("../mobile/StockOpsHub").then((m) => ({ default: m.ReceiveHub })));

export default function FilmWorkbench() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const legacyKind = params.get("kind");
  if (legacyKind === "pf" || legacyKind === "material") {
    const stockKind = legacyKind === "pf" ? "pf" : "materials";
    const stockTab = params.get("tab") === "issue" ? "lots" : "items";
    return <Navigate to={`/stock?kind=${stockKind}&tab=${stockTab}`} replace />;
  }
  const oldPlanSub = params.get("sub");
  if (params.get("tab") === "requests") {
    return <Navigate to={`/stock?tab=requests${oldPlanSub ? `&sub=${oldPlanSub}` : ""}`} replace />;
  }
  if (params.get("tab") === "plan" && (oldPlanSub === "requests" || oldPlanSub === "norms")) {
    return <Navigate to={`/stock?tab=requests&sub=${oldPlanSub}`} replace />;
  }
  if (params.get("tab") === "plan" && oldPlanSub === "reconciliation") {
    return <Navigate to="/film-operations?tab=reconciliation&recon=rolls" replace />;
  }
  if (params.get("tab") === "plan" && oldPlanSub === "pick-route") {
    return <Navigate to="/production-tasks?tab=pick-route" replace />;
  }
  const items = [
    ...(hasPerm(user, "units.issue", "production_tasks.manage", "production_tasks.view")
      ? [{ key: "plan", label: "⚡ Выдача под потребность", children: <FilmIssueBoard /> }]
      : []),
    ...(hasPerm(user, "units.issue", "units.return")
      ? [{ key: "issue", label: "✂️ Нарезка рулонов в штрипсы и возвраты", children: <IssueHub /> }]
      : []),
    ...(hasPerm(user, "units.receive")
      ? [{ key: "receive", label: "📥 Приёмка целых рулонов", children: <ReceiveHub /> }]
      : []),
    ...(hasPerm(user, "units.issue", "units.return", "production_tasks.manage", "reports.view")
      ? [{ key: "reconciliation", label: "🔗 Сверка штрипсов и рулонов (привязка к заданиям)", children: <FilmReconciliationPanel /> }]
      : []),
  ];
  const requested = params.get("tab");
  const defaultTab = hasPerm(user, "production_tasks.manage", "production_tasks.view")
    ? "plan"
    : hasPerm(user, "units.issue")
      ? "issue"
      : hasPerm(user, "reports.view")
          ? "reconciliation"
          : items[0]?.key;
  const active = items.some((item) => item.key === requested) ? requested! : defaultTab;
  const canInventory = !!user?.is_superuser || hasPerm(user, "inventory.manage");

  return (
    <Card
      title="Плёнка"
      styles={{ body: { paddingTop: 8 } }}
      extra={
        canInventory ? (
          <Space size={8} wrap>
            <Button
              size="small"
              onClick={() => navigate("/inventory?place_type=warehouse")}
            >
              🔄 Инвентаризация
            </Button>
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => navigate("/inventory/express")}
              style={{ borderColor: "#722ed1", color: "#722ed1" }}
            >
              📱 Экспресс-ревизия
            </Button>
          </Space>
        ) : undefined
      }
    >
      <Tabs
        activeKey={active}
        destroyOnHidden
        items={items}
        onChange={(key) => setParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("tab", key);
          return next;
        }, { replace: true })}
      />
    </Card>
  );
}
