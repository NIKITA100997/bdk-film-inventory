import { useState } from "react";
import { Alert, Button, Card, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { cancelOrder, getLagging, reduceOrderLine, sendLagDigest, type ReduceRow } from "../../../api/orderControl";
import type { ProductionOrder } from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";

const d = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM") : "—");

/** Отстают от плана (12.10, этап 4): несделанное прошедших дней плана или
 * план позже обещанной готовности. Сводка в Битрикс24 — сама утром. */
export function LaggingCard({ canManage }: { canManage: boolean }) {
  const q = useQuery({ queryKey: ["lagging"], queryFn: getLagging });
  const send = useMutation({
    mutationFn: sendLagDigest,
    onSuccess: (r) => message.success(r.orders ? `Сводка отправлена: заказов ${r.orders}` : "Битрикс24 не подключён или отставаний нет"),
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отправить")),
  });
  const rows = q.data ?? [];
  return (
    <Card
      size="small"
      title={
        <Space>
          Отстают от плана
          {rows.length ? <Tag color="red">{rows.length}</Tag> : <Tag color="green">нет</Tag>}
        </Space>
      }
      extra={canManage && rows.length > 0 && <Button size="small" loading={send.isPending} onClick={() => send.mutate()}>Сводку в Битрикс24</Button>}
    >
      {rows.length === 0 ? (
        <Typography.Text type="secondary">Все запущенные заказы идут по плану.</Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey="order_id"
          pagination={false}
          dataSource={rows}
          columns={[
            { title: "Заказ", render: (_, r) => <Link to={`/production-orders/${r.order_id}`}>№{r.order_id} «{r.name}»{r.customer ? ` · ${r.customer}` : ""}</Link> },
            { title: "Менеджер", dataIndex: "manager", render: (v) => v ?? "—" },
            { title: "Не сделано по плану", align: "right", render: (_, r) => (r.overdue ? <Typography.Text type="danger">{r.overdue} шт</Typography.Text> : "—") },
            {
              title: "Готово по плану / обещано",
              render: (_, r) => (r.late ? <Tag color="red">{d(r.plan_finish)} позже {d(r.promised_ready)}</Tag> : `${d(r.plan_finish)} / ${d(r.promised_ready)}`),
            },
          ]}
        />
      )}
    </Card>
  );
}

/** Клиент уменьшил количество в запущенном заказе: предпросмотр по строкам
 * заданий — сколько сделано, было → станет, излишек; уменьшается только
 * несделанное, сделанные п/ф остаются в остатке участка под другие двери. */
export function ReduceModal({ order, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const qc = useQueryClient();
  const [lineId, setLineId] = useState<number | undefined>(order.lines[0]?.id);
  const line = order.lines.find((l) => l.id === lineId);
  const [qty, setQty] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ rows: ReduceRow[]; merged: string[] } | null>(null);
  const run = useMutation({
    mutationFn: (apply: boolean) => reduceOrderLine(order.id, lineId!, qty!, reason.trim() || null, apply),
    onSuccess: (r) => {
      if (r.applied) {
        qc.invalidateQueries({ queryKey: ["production-order"] });
        qc.invalidateQueries({ queryKey: ["production-orders"] });
        message.success("Количество уменьшено, сроки пересчитаны");
        onClose();
      } else setPreview(r);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не получилось")),
  });
  return (
    <Modal
      open
      width={820}
      title={`Уменьшить количество — заказ №${order.id}`}
      onCancel={onClose}
      okText="Уменьшить"
      cancelText="Отмена"
      okButtonProps={{ disabled: !preview || !reason.trim(), loading: run.isPending && run.variables }}
      onOk={() => run.mutate(true)}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space wrap>
          <Select
            style={{ width: 420 }}
            value={lineId}
            onChange={(v) => {
              setLineId(v);
              setPreview(null);
            }}
            options={order.lines.map((l) => ({ value: l.id, label: `${l.item_name} — ${l.quantity} шт` }))}
          />
          <InputNumber min={1} max={line ? line.quantity - 1 : undefined} placeholder="Новое кол-во" value={qty} onChange={(v) => { setQty(v); setPreview(null); }} />
          <Button disabled={!qty || !lineId} loading={run.isPending && !run.variables} onClick={() => run.mutate(false)}>
            Показать, что изменится
          </Button>
        </Space>
        {preview && (
          <>
            <Table<ReduceRow>
              size="small"
              rowKey="task_line_id"
              pagination={false}
              dataSource={preview.rows}
              columns={[
                { title: "Участок", dataIndex: "area" },
                { title: "Что", dataIndex: "what" },
                { title: "Сделано", align: "right", dataIndex: "done" },
                { title: "Было → станет", render: (_, r) => `${r.old} → ${r.new}` },
                { title: "Излишек", align: "right", render: (_, r) => (r.surplus ? <Tag color="orange">{r.surplus} шт</Tag> : "—") },
              ]}
            />
            {preview.rows.some((r) => r.surplus > 0) && (
              <Alert type="info" showIcon message="Сделанное сверх нового количества остаётся: п/ф — в остатке участка под другие двери, двери — на складе ГП." />
            )}
            {preview.merged.length > 0 && (
              <Alert type="warning" showIcon message={`Объединённые строки п/ф не уменьшаются (общие для нескольких позиций): ${preview.merged.join(", ")}. Лишнее уйдёт в остаток участка.`} />
            )}
            <Input placeholder="Причина (обязательно): клиент изменил счёт…" value={reason} onChange={(e) => setReason(e.target.value)} />
          </>
        )}
      </Space>
    </Modal>
  );
}

export function useCancelOrder(order: ProductionOrder | null) {
  const qc = useQueryClient();
  return () => {
    if (!order) return;
    let reason = "";
    Modal.confirm({
      title: `Отменить заказ №${order.id}?`,
      content: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>Задания уйдут в архив; сделанные п/ф останутся в остатке участков под другие заказы.</Typography.Text>
          <Input placeholder="Причина (обязательно)" onChange={(e) => (reason = e.target.value)} />
        </Space>
      ),
      okText: "Отменить заказ",
      okButtonProps: { danger: true },
      cancelText: "Не отменять",
      onOk: async () => {
        if (reason.trim().length < 2) {
          message.error("Укажите причину");
          throw new Error("no reason");
        }
        try {
          await cancelOrder(order.id, reason.trim());
          qc.invalidateQueries({ queryKey: ["production-order"] });
          qc.invalidateQueries({ queryKey: ["production-orders"] });
          message.success("Заказ отменён");
        } catch (e) {
          message.error(apiErrorMessage(e, "Не удалось отменить"));
          throw e;
        }
      },
    });
  };
}
