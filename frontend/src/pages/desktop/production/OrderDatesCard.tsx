import { useState } from "react";
import { Button, Card, DatePicker, Descriptions, Input, Modal, Progress, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  DATE_CHANGE_REASONS,
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  changeOrderPromise,
  type DateChange,
  type ProductionOrder,
} from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";

const d = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "—");
const FIELD: Record<DateChange["field"], string> = { ship: "отгрузка", ready: "готовность", ready_fact: "факт готовности" };

/** Даты заказа (12.10): желаемая вилка, обещанные готовность и отгрузка,
 * плановая готовность, факт готовности и отгрузки; перенос — с причиной,
 * история переносов. */
export default function OrderDatesCard({ order, canManage, totalQty }: { order: ProductionOrder; canManage: boolean; totalQty: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<Dayjs | null>(null);
  const [ship, setShip] = useState<Dayjs | null>(null);
  const [fact, setFact] = useState<Dayjs | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [comment, setComment] = useState("");
  const committed = order.status !== "draft" || order.request_status === "accepted";
  const moved =
    (ready && ready.format("YYYY-MM-DD") !== order.promised_ready) || (ship && ship.format("YYYY-MM-DD") !== order.ship_date);

  const mutation = useMutation({
    mutationFn: () =>
      changeOrderPromise(order.id, {
        ready_date: ready ? ready.format("YYYY-MM-DD") : null,
        ship_date: ship ? ship.format("YYYY-MM-DD") : null,
        ready_fact: fact && fact.format("YYYY-MM-DD") !== order.ready_fact ? fact.format("YYYY-MM-DD") : null,
        reason: reason ?? null,
        comment: comment.trim() || null,
      }),
    onSuccess: (o) => {
      qc.setQueryData(["production-order", o.id], o);
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      setOpen(false);
      message.success("Даты сохранены");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить даты")),
  });

  const shipped = order.shipped_qty ?? 0;
  const late = order.plan_late;
  const openModal = () => {
    setReady(order.promised_ready ? dayjs(order.promised_ready) : null);
    setShip(order.ship_date ? dayjs(order.ship_date) : null);
    setFact(order.ready_fact ? dayjs(order.ready_fact) : null);
    setReason(undefined);
    setComment("");
    setOpen(true);
  };

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          Даты и отгрузка
          <Tag color={PRIORITY_COLOR[order.priority ?? 0]}>приоритет: {PRIORITY_LABEL[order.priority ?? 0]}</Tag>
          {order.customer && <Typography.Text type="secondary">клиент: {order.customer}</Typography.Text>}
          {order.amount_rub != null && <Typography.Text type="secondary">{order.amount_rub.toLocaleString("ru-RU")} ₽</Typography.Text>}
        </Space>
      }
      extra={canManage && order.status !== "closed" && <Button onClick={openModal}>Перенести / поправить</Button>}
    >
      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
        <Descriptions.Item label="Вилка клиента">{order.ship_from || order.ship_to ? `${d(order.ship_from)} — ${d(order.ship_to)}` : "—"}</Descriptions.Item>
        <Descriptions.Item label="Обещанная готовность">{d(order.promised_ready)}</Descriptions.Item>
        <Descriptions.Item label="Обещанная отгрузка">{order.request_status === "submitted" ? "ставит производство" : d(order.ship_date)}</Descriptions.Item>
        <Descriptions.Item label="Готово по плану">
          {order.plan_finish ? <Tag color={late ? "red" : "green"}>{d(order.plan_finish)}{late ? " — позже обещанного" : ""}</Tag> : "—"}
        </Descriptions.Item>
        <Descriptions.Item label="Факт готовности">{d(order.ready_fact)}</Descriptions.Item>
        <Descriptions.Item label="Отгружено">
          <Space size={8}>
            <Progress percent={totalQty ? Math.round((shipped / totalQty) * 100) : 0} size="small" style={{ width: 100 }} />
            <span>
              {shipped} из {totalQty}
              {order.last_shipped_at ? `, последняя ${d(order.last_shipped_at)}` : ""}
            </span>
          </Space>
        </Descriptions.Item>
      </Descriptions>
      {(order.date_changes ?? []).length > 0 && (
        <Table<DateChange>
          size="small"
          style={{ marginTop: 8 }}
          rowKey={(c) => `${c.created_at}-${c.field}`}
          pagination={false}
          dataSource={order.date_changes}
          columns={[
            { title: "Когда", render: (_, c) => dayjs(c.created_at).format("DD.MM HH:mm") },
            { title: "Что", render: (_, c) => FIELD[c.field] },
            { title: "Было → стало", render: (_, c) => `${d(c.old_date)} → ${d(c.new_date)}` },
            { title: "Причина", render: (_, c) => [c.reason_name, c.comment].filter(Boolean).join(": ") || "—" },
            { title: "Кто", dataIndex: "user_name" },
          ]}
        />
      )}
      <Modal
        open={open}
        title="Даты заказа"
        okText="Сохранить"
        cancelText="Отмена"
        onCancel={() => setOpen(false)}
        okButtonProps={{
          loading: mutation.isPending,
          disabled:
            (!!moved && committed && (!reason || (reason === "other" && !comment.trim()))) ||
            (!!ready && !!ship && ready.isAfter(ship)),
        }}
        onOk={() => mutation.mutate()}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Space wrap>
            <span>Готовность:</span>
            <DatePicker format="DD.MM.YYYY" value={ready} onChange={setReady} />
            <span>Отгрузка:</span>
            <DatePicker format="DD.MM.YYYY" value={ship} onChange={setShip} />
          </Space>
          {moved && committed && (
            <>
              <Select
                placeholder="Причина переноса"
                style={{ width: "100%" }}
                options={DATE_CHANGE_REASONS}
                value={reason}
                onChange={setReason}
              />
              <Input.TextArea rows={2} placeholder="Комментарий" value={comment} onChange={(e) => setComment(e.target.value)} />
              <Typography.Text type="secondary">Перенос попадёт в историю; менеджер увидит его в заказе.</Typography.Text>
            </>
          )}
          <Space wrap>
            <span>Факт готовности:</span>
            <DatePicker format="DD.MM.YYYY" value={fact} onChange={setFact} />
            <Typography.Text type="secondary">ставится сама по приходу всего на склад ГП; поправить — если приняли без программы</Typography.Text>
          </Space>
        </Space>
      </Modal>
    </Card>
  );
}
