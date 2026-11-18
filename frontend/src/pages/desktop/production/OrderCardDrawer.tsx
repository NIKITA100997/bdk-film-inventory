import { useState } from "react";
import { Button, Drawer, Result, Space, Spin, Typography } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getProductionOrder, type ProductionOrder, type OrderTask } from "../../../api/productionOrders";
import { OrderModal, OrderView } from "./ProductionOrders";
import CreateTaskModal from "./CreateTaskModal";
import OperationTaskModal from "./OperationTaskModal";
import PfSupplyModal from "./PfSupplyModal";

/** Карточка заказа в виде всплывающей боковой панели (Drawer).
 * Позволяет просматривать и управлять заказом (ход, отчёт, материалы, план,
 * история, запуск, редактирование строк) прямо из монитора производства
 * без перехода на отдельную страницу. */
export default function OrderCardDrawer({
  orderId,
  onClose,
  canManage = false,
}: {
  orderId: number | null;
  onClose: () => void;
  canManage?: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["production-order", orderId],
    queryFn: () => getProductionOrder(orderId!),
    enabled: orderId != null && orderId > 0,
  });

  const [editing, setEditing] = useState<ProductionOrder | null>(null);
  const [taskCreate, setTaskCreate] = useState<{ kind: "film" | "ops"; orderId: number } | null>(null);
  const [supplyTarget, setSupplyTarget] = useState<{ id: number; name: string } | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["production-order", orderId] });
    qc.invalidateQueries({ queryKey: ["production-monitor"] });
    qc.invalidateQueries({ queryKey: ["production-orders"] });
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
  };

  const order = q.data;

  return (
    <Drawer
      open={orderId != null}
      onClose={onClose}
      width={Math.min(1150, typeof window !== "undefined" ? window.innerWidth - 32 : 1150)}
      destroyOnClose
      styles={{ body: { padding: 16 } }}
    >
      {q.isLoading ? (
        <Spin style={{ display: "block", margin: "64px auto" }} />
      ) : !order ? (
        <Result status="404" title="Заказ не найден" extra={<Button onClick={onClose}>Закрыть</Button>} />
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {(order.customer_orders?.length ?? 0) > 0 && (
            <Typography.Text style={{ fontSize: 13 }}>
              Из заказов покупателей:{" "}
              {order.customer_orders!.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ", "}
                  <Link to={`/customer-orders/${c.id}`} onClick={onClose}>
                    {c.invoice_no}
                  </Link>
                  {c.customer && <Typography.Text type="secondary"> ({c.customer})</Typography.Text>}
                </span>
              ))}
            </Typography.Text>
          )}

          <OrderView
            order={order}
            onClose={() => {
              invalidate();
              onClose();
            }}
            onEdit={(o) => setEditing(o)}
            canManage={canManage}
            onAddTask={(kind, oid) => setTaskCreate({ kind, orderId: oid })}
            onSupply={(t: OrderTask) => setSupplyTarget({ id: t.id, name: t.name ?? "" })}
          />

          {editing && (
            <OrderModal
              order={editing}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                invalidate();
              }}
            />
          )}

          <CreateTaskModal
            open={taskCreate?.kind === "film"}
            orderId={taskCreate?.orderId}
            onClose={() => {
              setTaskCreate(null);
              invalidate();
            }}
            onCreated={(t, needsPf) => {
              invalidate();
              if (needsPf) setSupplyTarget({ id: t.id, name: t.name ?? "" });
            }}
          />

          <OperationTaskModal
            open={taskCreate?.kind === "ops"}
            orderId={taskCreate?.orderId}
            onClose={() => {
              setTaskCreate(null);
              invalidate();
            }}
          />

          {supplyTarget && (
            <PfSupplyModal
              taskId={supplyTarget.id}
              taskName={supplyTarget.name}
              canManage={canManage}
              onClose={() => {
                setSupplyTarget(null);
                invalidate();
              }}
            />
          )}
        </Space>
      )}
    </Drawer>
  );
}
