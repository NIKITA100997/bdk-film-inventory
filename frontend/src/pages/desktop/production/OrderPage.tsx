import { useState } from "react";
import { Button, Result, Space, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { getProductionOrder, type ProductionOrder } from "../../../api/productionOrders";
import { useAuth } from "../../../auth/AuthContext";
import { useTabTitle } from "../../../layout/tabTitle";
import { OrderModal, OrderView } from "./ProductionOrders";
import CreateTaskModal from "./CreateTaskModal";
import OperationTaskModal from "./OperationTaskModal";
import PfSupplyModal from "./PfSupplyModal";

/** Страница заказа на производство (05.10): во всю ширину вместо боковой
 * панели; у черновика — рабочее место запуска, к которому можно вернуться. */
export default function OrderPage() {
  const { id } = useParams();
  const orderId = Number(id);
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const q = useQuery({ queryKey: ["production-order", orderId], queryFn: () => getProductionOrder(orderId), enabled: orderId > 0 });
  const [editing, setEditing] = useState<ProductionOrder | null>(null);
  const [taskCreate, setTaskCreate] = useState<{ kind: "film" | "ops"; orderId: number } | null>(null);
  const [supplyTarget, setSupplyTarget] = useState<{ id: number; name: string } | null>(null);
  useTabTitle(q.data ? `Заказ №${q.data.id} «${q.data.name}»` : null);

  if (q.isLoading) return <Spin style={{ display: "block", margin: 48 }} />;
  if (!q.data)
    return (
      <Result status="404" title="Заказ не найден" extra={<Button onClick={() => navigate("/production-orders")}>К заказам</Button>} />
    );
  const order = q.data;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link" style={{ padding: 0 }} onClick={() => navigate("/production-orders")}>
        ← Заказы на производство
      </Button>
      <OrderView
        order={order}
        onClose={() => navigate("/production-orders")}
        onEdit={(o) => setEditing(o)}
        canManage={canManage}
        onAddTask={(kind, oid) => setTaskCreate({ kind, orderId: oid })}
        onSupply={(t) => setSupplyTarget({ id: t.id, name: t.name })}
      />
      {editing && <OrderModal order={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
      <CreateTaskModal
        open={taskCreate?.kind === "film"}
        orderId={taskCreate?.orderId}
        onClose={() => setTaskCreate(null)}
        onCreated={(t, needsPf) => {
          if (needsPf) setSupplyTarget({ id: t.id, name: t.name ?? "" });
        }}
      />
      <OperationTaskModal open={taskCreate?.kind === "ops"} orderId={taskCreate?.orderId} onClose={() => setTaskCreate(null)} />
      {supplyTarget && (
        <PfSupplyModal taskId={supplyTarget.id} taskName={supplyTarget.name} canManage={canManage} onClose={() => setSupplyTarget(null)} />
      )}
    </Space>
  );
}
