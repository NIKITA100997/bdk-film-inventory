import { useState } from "react";
import { Button, Card, Modal, Segmented, Space, Tabs } from "antd";
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
  const canPlan = hasPerm(user, "units.issue", "production_tasks.manage", "production_tasks.view");
  const canIssue = hasPerm(user, "units.issue", "units.return");
  const canReceive = hasPerm(user, "units.receive");
  const canRecon = hasPerm(user, "units.issue", "units.return", "production_tasks.manage", "reports.view");
  const [receiveOpen, setReceiveOpen] = useState(false);

  const requested = params.get("tab");
  const initialMode = requested === "issue" && canIssue ? "issue" : canPlan ? "plan" : "issue";
  const [workMode, setWorkMode] = useState<"plan" | "issue">(initialMode);

  const modeOptions = [
    ...(canPlan ? [{ label: "⚡ По потребности задания", value: "plan" }] : []),
    ...(canIssue ? [{ label: "✂️ Нарезка, выдача и возврат", value: "issue" }] : []),
  ];

  const items = [
    ...(canPlan || canIssue
      ? [
          {
            key: "work",
            label: "⚡ Выдача, нарезка и возврат",
            children: (
              <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                {modeOptions.length > 1 && (
                  <Segmented
                    size="large"
                    value={workMode}
                    onChange={(v) => setWorkMode(v as "plan" | "issue")}
                    options={modeOptions}
                  />
                )}
                {workMode === "plan" && canPlan ? <FilmIssueBoard /> : <IssueHub />}
              </Space>
            ),
          },
        ]
      : []),
    ...(canRecon
      ? [{ key: "reconciliation", label: "🔗 Сверка штрипсов и рулонов", children: <FilmReconciliationPanel /> }]
      : []),
  ];

  const mappedRequested = requested === "plan" || requested === "issue" ? "work" : requested;
  const defaultTab = items[0]?.key;
  const active = items.some((item) => item.key === mappedRequested) ? mappedRequested! : defaultTab;
  const canInventory = !!user?.is_superuser || hasPerm(user, "inventory.manage");

  return (
    <Card
      title="Плёнка"
      styles={{ body: { paddingTop: 8 } }}
      extra={
        canReceive || canInventory ? (
          <Space size={8} wrap>
            {canReceive && (
              <Button size="small" type="primary" ghost onClick={() => setReceiveOpen(true)}>
                📥 Приёмка рулонов
              </Button>
            )}
            {canInventory && (
              <>
                <Button size="small" onClick={() => navigate("/inventory?place_type=warehouse")}>
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
              </>
            )}
          </Space>
        ) : undefined
      }
    >
      <Tabs
        activeKey={active}
        destroyOnHidden
        items={items}
        onChange={(key) =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.set("tab", key);
              return next;
            },
            { replace: true },
          )
        }
      />
      <Modal
        open={receiveOpen}
        onCancel={() => setReceiveOpen(false)}
        footer={null}
        width={900}
        title="📥 Приёмка целых рулонов"
        destroyOnHidden
      >
        <ReceiveHub />
      </Modal>
    </Card>
  );
}
