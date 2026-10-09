import { useState } from "react";
import { Alert, Button, Card, DatePicker, Input, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  acceptOrderRequest,
  getPlanCheck,
  returnOrderRequest,
  submitOrderRequest,
  type PlanCheck,
  type ProductionOrder,
} from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";

const d = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "—");

/** Заявка менеджера на производство (09.10): вилка отгрузки, оценка срока
 * по маршруту и загрузке участков, отправка; производство принимает
 * (твёрдая дата отгрузки — 100%) или возвращает с комментарием. */
export default function RequestPanel({
  order,
  canManage,
  canRequest,
}: {
  order: ProductionOrder;
  canManage: boolean;
  canRequest: boolean;
}) {
  const qc = useQueryClient();
  const [check, setCheck] = useState<PlanCheck | null>(null);
  const [comment, setComment] = useState("");
  const [shipDate, setShipDate] = useState<Dayjs | null>(null);
  const status = order.request_status ?? null;
  const editable = canManage || (canRequest && status !== "submitted" && status !== "accepted");
  const done = (o: ProductionOrder, text: string) => {
    qc.setQueryData(["production-order", o.id], o);
    qc.invalidateQueries({ queryKey: ["production-orders"] });
    setComment("");
    message.success(text);
  };

  const checkMutation = useMutation({
    mutationFn: () => getPlanCheck(order.id),
    onSuccess: (c) => {
      setCheck(c);
      // Подсказка производству: раньше вилки нельзя, раньше готовности — тоже.
      if (c.earliest && !shipDate) {
        let best = dayjs(c.earliest).add(1, "day");
        if (order.ship_from && best.isBefore(dayjs(order.ship_from))) best = dayjs(order.ship_from);
        setShipDate(best);
      }
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось оценить срок")),
  });
  const submit = useMutation({
    mutationFn: () => submitOrderRequest(order.id, comment.trim() || null),
    onSuccess: (o) => done(o, "Заявка отправлена в производство"),
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отправить")),
  });
  const accept = useMutation({
    mutationFn: () => acceptOrderRequest(order.id, shipDate!.format("YYYY-MM-DD"), comment.trim() || null),
    onSuccess: (o) => done(o, `Заявка принята: отгрузка ${d(o.ship_date)}`),
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось принять")),
  });
  const ret = useMutation({
    mutationFn: () => returnOrderRequest(order.id, comment.trim()),
    onSuccess: (o) => done(o, "Заявка возвращена менеджеру"),
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось вернуть")),
  });

  const statusTag =
    status === "submitted" ? (
      <Tag color="gold">отправлена {order.submitted_by_name ? `· ${order.submitted_by_name}` : ""} {d(order.submitted_at)}</Tag>
    ) : status === "returned" ? (
      <Tag color="red">возвращена {order.decided_by_name ? `· ${order.decided_by_name}` : ""}</Tag>
    ) : status === "accepted" ? (
      <Tag color="green">принята {order.decided_by_name ? `· ${order.decided_by_name}` : ""}</Tag>
    ) : (
      <Tag>черновик заявки</Tag>
    );

  return (
    <Card size="small" title={<Space>Заявка на производство {statusTag}</Space>}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space wrap size={24}>
          <span>
            Вилка отгрузки: <b>{order.ship_from || order.ship_to ? `${d(order.ship_from)} — ${d(order.ship_to)}` : "не задана"}</b>
          </span>
          <span>
            Отгрузка (100%): <b>{order.ship_date && status !== "submitted" ? d(order.ship_date) : "ставит производство"}</b>
          </span>
        </Space>
        {order.request_comment && (
          <Alert
            type={status === "returned" ? "warning" : "info"}
            showIcon
            message={status === "returned" ? "Комментарий производства" : status === "accepted" ? "Комментарий производства" : "Комментарий менеджера"}
            description={order.request_comment}
          />
        )}

        <Space wrap>
          <Button onClick={() => checkMutation.mutate()} loading={checkMutation.isPending}>
            Проверить срок
          </Button>
          <Typography.Text type="secondary">по срокам операций и загрузке участков — оценка, без записи</Typography.Text>
        </Space>
        {check &&
          (check.error ? (
            <Alert type="error" showIcon message={check.error} />
          ) : (
            <>
              <Alert
                type={check.fits === false ? "error" : check.fits ? "success" : "info"}
                showIcon
                message={
                  check.earliest
                    ? `Раньше всего готово к ${d(check.earliest)}` +
                      (check.fits === true ? " — в вилку успеваем" : check.fits === false ? ` — в вилку (до ${d(order.ship_to)}) не успеваем` : "")
                    : "Срок не посчитался"
                }
                description={
                  check.bottleneck
                    ? `Держит загрузка участка «${check.bottleneck}». По срокам операций — ${d(check.by_route)}.`
                    : `Держат сроки операций по маршруту. Мощность задана не у всех участков — там очередь не учтена.`
                }
              />
              <Table
                size="small"
                rowKey="area"
                pagination={false}
                dataSource={check.areas}
                columns={[
                  { title: "Участок", dataIndex: "name" },
                  { title: "Этот заказ, шт", dataIndex: "order_pieces", align: "right" },
                  { title: "Уже в очереди, шт", dataIndex: "queue_pieces", align: "right" },
                  { title: "Мощность в день", dataIndex: "per_day", align: "right", render: (v) => v ?? <Typography.Text type="secondary">не задана</Typography.Text> },
                  { title: "Дней", dataIndex: "days", align: "right", render: (v) => v ?? "—" },
                ]}
              />
            </>
          ))}

        {canRequest && !canManage && editable && (
          <Space wrap>
            <Input
              style={{ width: 360 }}
              placeholder="Комментарий для производства (необязательно)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button type="primary" disabled={!order.ship_to || order.lines.length === 0} loading={submit.isPending} onClick={() => submit.mutate()}>
              {status === "returned" ? "Отправить снова" : "Отправить в производство"}
            </Button>
            {!order.ship_to && <Typography.Text type="warning">Сначала задайте вилку отгрузки («Изменить строки»)</Typography.Text>}
          </Space>
        )}
        {canManage && status === "submitted" && (
          <Space wrap>
            <span>Отгрузка (100%):</span>
            <DatePicker format="DD.MM.YYYY" value={shipDate} onChange={setShipDate} />
            <Input style={{ width: 300 }} placeholder="Комментарий менеджеру" value={comment} onChange={(e) => setComment(e.target.value)} />
            <Button type="primary" disabled={!shipDate} loading={accept.isPending} onClick={() => accept.mutate()}>
              Принять
            </Button>
            <Button danger disabled={!comment.trim()} loading={ret.isPending} onClick={() => ret.mutate()}>
              Вернуть с комментарием
            </Button>
          </Space>
        )}
        {canManage && status === "submitted" && shipDate && order.ship_to && shipDate.isAfter(dayjs(order.ship_to)) && (
          <Typography.Text type="warning">Дата позже вилки клиента — согласуйте с менеджером.</Typography.Text>
        )}
      </Space>
    </Card>
  );
}
