import { useState } from "react";
import { Button, Drawer, Result, Skeleton, Space, Typography } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getProductionOrder, type ProductionOrder, type OrderTask } from "../../../api/productionOrders";
import { OrderModal, OrderView } from "./ProductionOrders";
import CreateTaskModal from "./CreateTaskModal";
import OperationTaskModal from "./OperationTaskModal";
import PfSupplyModal from "./PfSupplyModal";

/** Карточка заказа в виде боковой рабочей панели (Drawer).
 * Позволяет просматривать и управлять заказом (ход, отчёт, материалы, план,
 * история, запуск, редактирование строк) поверх монитора производства,
 * сохраняя ширину для таблиц и контекст исходного экрана.
 * Моментально отображает данные благодаря кэшированию и пакетной выборке на бэкенде. */
export default function OrderCardModal({
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
    staleTime: 60_000, // 1 минута в памяти для моментального повторного открытия без задержек
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
      placement="right"
      width={Math.min(1480, typeof window !== "undefined" ? window.innerWidth : 1480)}
      destroyOnHidden={false}
      styles={{
        body: {
          overflowY: "auto",
          padding: 12,
        },
      }}
    >
      {q.isLoading && !order ? (
        <div style={{ padding: "24px 8px" }}>
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
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
