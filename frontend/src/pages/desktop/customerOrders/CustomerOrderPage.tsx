import { useState } from "react";
import { Alert, Button, Card, DatePicker, Descriptions, Input, Modal, Popconfirm, Progress, Result, Space, Spin, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import {
  STAGE_COLOR,
  acceptCustomerOrder,
  cancelCustomerOrder,
  deleteCustomerOrder,
  getCustomerOrder,
  getCustomerPlanCheck,
  launchCustomerOrders,
  returnCustomerOrder,
  submitCustomerOrder,
  type CustomerDateChange,
  type CustomerOrder,
} from "../../../api/customerOrders";
import { ORDER_STATUS_LABEL, PRIORITY_COLOR, PRIORITY_LABEL, type OrderStatus, type PlanCheck } from "../../../api/productionOrders";
import { useTabTitle } from "../../../layout/tabTitle";
import { apiErrorMessage } from "../../../utils/apiError";
import { OrderNeedsCard } from "../production/NeedsViews";
import BitrixDealCard from "./BitrixDealCard";
import FilmReserveCard from "./FilmReserveCard";
import { CustomerOrderModal, MoveDatesModal, PlanCheckView, editableBy, fmt, useCustomerOrderRights } from "./parts";

const FIELD: Record<CustomerDateChange["field"], string> = { ship: "отгрузка", ready: "готовность", ready_fact: "факт готовности" };

/** Страница заказа клиента: заявка в производство (отправить / принять /
 * вернуть), даты и их перенос, потребность, позиции и запуски. */
export default function CustomerOrderPage() {
  const { id } = useParams();
  const orderId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { production, canEdit } = useCustomerOrderRights();
  const q = useQuery({ queryKey: ["customer-order", orderId], queryFn: () => getCustomerOrder(orderId), enabled: orderId > 0 });
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [check, setCheck] = useState<PlanCheck | null>(null);
  const [comment, setComment] = useState("");
  const [ready, setReady] = useState<Dayjs | null>(null);
  const [ship, setShip] = useState<Dayjs | null>(null);
  useTabTitle(q.data ? `Счёт ${q.data.invoice_no}` : null);

  const done = (o: CustomerOrder, text: string) => {
    qc.setQueryData(["customer-order", o.id], o);
    qc.invalidateQueries({ queryKey: ["customer-orders"] });
    qc.invalidateQueries({ queryKey: ["order-needs"] });
    setComment("");
    message.success(text);
  };
  const fail = (text: string) => (e: unknown) => message.error(apiErrorMessage(e, text));
  const checkM = useMutation({
    mutationFn: () => getCustomerPlanCheck(orderId),
    onSuccess: (c) => {
      setCheck(c);
      const o = q.data;
      // Подсказка производству: готовность — раньше всего; отгрузка — день после, не раньше вилки.
      if (o && c.earliest && o.status === "submitted") {
        if (!ready) setReady(dayjs(c.earliest));
        if (!ship) {
          let best = dayjs(c.earliest).add(1, "day");
          if (o.ship_from && best.isBefore(dayjs(o.ship_from))) best = dayjs(o.ship_from);
          setShip(best);
        }
      }
    },
    onError: fail("Не удалось оценить срок"),
  });
  const submit = useMutation({ mutationFn: () => submitCustomerOrder(orderId, comment.trim() || null), onSuccess: (o) => done(o, "Отправлен в производство"), onError: fail("Не удалось отправить") });
  const accept = useMutation({
    mutationFn: () => acceptCustomerOrder(orderId, ship!.format("YYYY-MM-DD"), ready ? ready.format("YYYY-MM-DD") : null, comment.trim() || null),
    onSuccess: (o) => done(o, `Заказ принят: отгрузка ${fmt(o.ship_date)}`),
    onError: fail("Не удалось принять"),
  });
  const ret = useMutation({ mutationFn: () => returnCustomerOrder(orderId, comment.trim()), onSuccess: (o) => done(o, "Возвращён менеджеру"), onError: fail("Не удалось вернуть") });
  const del = useMutation({
    mutationFn: () => deleteCustomerOrder(orderId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      message.success("Заказ удалён");
      navigate("/customer-orders");
    },
    onError: fail("Не удалось удалить"),
  });
  const cancelM = useMutation({ mutationFn: (reason: string) => cancelCustomerOrder(orderId, reason), onSuccess: (o) => done(o, "Заказ отменён"), onError: fail("Не удалось отменить") });
  const launch = useMutation({
    mutationFn: () => launchCustomerOrders([orderId], null),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      qc.invalidateQueries({ queryKey: ["customer-order"] });
      navigate(`/production-orders/${r.production_order_id}`);
    },
    onError: fail("Не удалось собрать запуск"),
  });

  if (q.isLoading) return <Spin style={{ display: "block", margin: 48 }} />;
  if (!q.data)
    return <Result status="404" title="Заказ не найден" extra={<Button onClick={() => navigate("/customer-orders")}>К заказам клиентов</Button>} />;
  const o = q.data;
  const left = Math.round((o.qty - o.launched) * 100) / 100;
  const canChange = canEdit && editableBy(o, production);
  const canCancel =
    canEdit && o.status !== "cancelled" && o.launched <= 0 && (production || o.status !== "accepted") && o.stage !== "shipped";
  const askCancel = () => {
    let reason = "";
    Modal.confirm({
      title: `Отменить заказ по счёту ${o.invoice_no}?`,
      content: <Input.TextArea rows={2} placeholder="Причина" onChange={(e) => (reason = e.target.value)} />,
      okText: "Отменить заказ",
      okButtonProps: { danger: true },
      cancelText: "Назад",
      onOk: () => {
        if (reason.trim().length < 2) {
          message.warning("Напишите причину");
          return Promise.reject();
        }
        return cancelM.mutateAsync(reason.trim());
      },
    });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link" style={{ padding: 0 }} onClick={() => navigate("/customer-orders")}>
        ← Заказы клиентов
      </Button>
      <Card
        title={
          <Space wrap>
            <span>
              Счёт {o.invoice_no}
              {o.customer ? ` · ${o.customer}` : ""}
            </span>
            <Tag color={STAGE_COLOR[o.stage]}>{o.stage_label}</Tag>
            {o.priority > 0 && <Tag color={PRIORITY_COLOR[o.priority]}>{PRIORITY_LABEL[o.priority]}</Tag>}
          </Space>
        }
        extra={
          <Space wrap>
            {canChange && <Button onClick={() => setEditing(true)}>Изменить</Button>}
            {canChange && o.launched === 0 && (
              <Popconfirm title="Удалить заказ клиента?" okText="Удалить" cancelText="Отмена" onConfirm={() => del.mutate()}>
                <Button danger>Удалить</Button>
              </Popconfirm>
            )}
            {canCancel && o.status !== "draft" && (
              <Button danger onClick={askCancel}>
                Отменить…
              </Button>
            )}
          </Space>
        }
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="Клиент">{o.customer ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="Дата счёта">{fmt(o.invoice_date)}</Descriptions.Item>
          <Descriptions.Item label="Сумма">{o.amount_rub != null ? `${o.amount_rub.toLocaleString("ru-RU")} ₽` : "—"}</Descriptions.Item>
          <Descriptions.Item label="Менеджер">{o.manager_name ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="Создан">{dayjs(o.created_at).format("DD.MM.YYYY")}</Descriptions.Item>
          {o.note && <Descriptions.Item label="Комментарий">{o.note}</Descriptions.Item>}
        </Descriptions>
      </Card>

      {/* Заявка в производство */}
      {o.status !== "cancelled" && o.status !== "accepted" && (
        <Card size="small" title="В производство">
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {o.request_comment && (
              <Alert
                type={o.status === "returned" ? "warning" : "info"}
                showIcon
                message={o.status === "returned" ? `Вернул ${o.decided_by_name ?? "производство"}` : "Комментарий менеджера"}
                description={o.request_comment}
              />
            )}
            <Space wrap>
              <Button onClick={() => checkM.mutate()} loading={checkM.isPending}>
                Проверить срок
              </Button>
              <Typography.Text type="secondary">по срокам операций и загрузке участков — оценка, без записи</Typography.Text>
            </Space>
            {check && <PlanCheckView check={check} shipTo={o.ship_to} />}
            {(o.status === "draft" || o.status === "returned") && canEdit && (
              <Space wrap>
                <Input style={{ width: 360 }} placeholder="Комментарий для производства (необязательно)" value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button type="primary" disabled={!o.ship_to || !o.lines.length} loading={submit.isPending} onClick={() => submit.mutate()}>
                  {o.status === "returned" ? "Отправить снова" : "Отправить в производство"}
                </Button>
                {!o.ship_to && <Typography.Text type="warning">Сначала задайте вилку отгрузки («Изменить»)</Typography.Text>}
              </Space>
            )}
            {o.status === "submitted" && !production && <Typography.Text type="secondary">Ждёт решения производства.</Typography.Text>}
            {o.status === "submitted" && production && (
              <>
                <Space wrap>
                  <span>Готовность:</span>
                  <DatePicker format="DD.MM.YYYY" value={ready} onChange={setReady} />
                  <span>Отгрузка (100%):</span>
                  <DatePicker format="DD.MM.YYYY" value={ship} onChange={setShip} />
                  <Input style={{ width: 300 }} placeholder="Комментарий менеджеру" value={comment} onChange={(e) => setComment(e.target.value)} />
                  <Button type="primary" disabled={!ship || (!!ready && ready.isAfter(ship))} loading={accept.isPending} onClick={() => accept.mutate()}>
                    Принять
                  </Button>
                  <Button danger disabled={!comment.trim()} loading={ret.isPending} onClick={() => ret.mutate()}>
                    Вернуть с комментарием
                  </Button>
                </Space>
                {ship && o.ship_to && ship.isAfter(dayjs(o.ship_to)) && (
                  <Typography.Text type="warning">Дата позже вилки клиента — согласуйте с менеджером.</Typography.Text>
                )}
              </>
            )}
          </Space>
        </Card>
      )}

      {/* Даты */}
      <Card
        size="small"
        title="Даты и отгрузка"
        extra={
          o.status !== "cancelled" &&
          (production || ["draft", "returned", "submitted"].includes(o.status)) &&
          canEdit && <Button onClick={() => setMoving(true)}>{production ? "Перенести / поправить" : "Изменить вилку"}</Button>
        }
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="Вилка клиента">{o.ship_from || o.ship_to ? `${fmt(o.ship_from)} — ${fmt(o.ship_to)}` : "—"}</Descriptions.Item>
          <Descriptions.Item label="Обещанная готовность">{o.status === "accepted" ? fmt(o.promised_ready) : "ставит производство"}</Descriptions.Item>
          <Descriptions.Item label="Обещанная отгрузка">{o.status === "accepted" ? fmt(o.ship_date) : "ставит производство"}</Descriptions.Item>
          <Descriptions.Item label="Готово по плану">
            {o.plan_finish ? <Tag color={o.plan_late ? "red" : "green"}>{fmt(o.plan_finish)}{o.plan_late ? " — позже обещанного" : ""}</Tag> : "—"}
          </Descriptions.Item>
          <Descriptions.Item label="Факт готовности">{fmt(o.ready_fact)}</Descriptions.Item>
          <Descriptions.Item label="Принято на склад / отгружено">
            <Space size={8}>
              <Progress
                percent={o.qty ? Math.round((o.received / o.qty) * 100) : 0}
                success={{ percent: o.qty ? Math.round((o.shipped / o.qty) * 100) : 0 }}
                size="small"
                style={{ width: 100 }}
              />
              <span>
                {o.received} / {o.shipped} из {o.qty}
                {o.last_shipped_at ? `, последняя отгрузка ${fmt(o.last_shipped_at)}` : ""}
              </span>
            </Space>
          </Descriptions.Item>
        </Descriptions>
        {o.date_changes.length > 0 && (
          <Table<CustomerDateChange>
            size="small"
            style={{ marginTop: 8 }}
            rowKey={(c) => `${c.created_at}-${c.field}-${c.new_date}`}
            pagination={false}
            dataSource={o.date_changes}
            columns={[
              { title: "Когда", render: (_, c) => dayjs(c.created_at).format("DD.MM HH:mm") },
              { title: "Что", render: (_, c) => FIELD[c.field] },
              { title: "Было → стало", render: (_, c) => `${fmt(c.old_date)} → ${fmt(c.new_date)}` },
              { title: "Причина", render: (_, c) => [c.reason_name, c.comment].filter(Boolean).join(": ") || "—" },
              { title: "Кто", dataIndex: "user_name" },
            ]}
          />
        )}
      </Card>

      {(o.bitrix_deals_on || !!o.bitrix_deal_id) && <BitrixDealCard order={o} canEdit={canEdit && o.status !== "cancelled"} />}

      {(o.status === "accepted" || o.status === "submitted") && left > 0 && <OrderNeedsCard orderId={o.id} customer />}

      {production && (o.status === "accepted" || o.status === "submitted") && left > 0 && <FilmReserveCard orderId={o.id} canEdit={production} />}

      {/* Позиции и запуски */}
      <Card
        size="small"
        title={`Позиции — ${o.lines.length}, ${o.qty} шт`}
        extra={
          production &&
          o.status === "accepted" &&
          left > 0 && (
            <Button type="primary" loading={launch.isPending} onClick={() => launch.mutate()}>
              Собрать запуск из этого заказа ({left} шт)
            </Button>
          )
        }
      >
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={o.lines}
          columns={[
            { title: "Позиция", dataIndex: "item_name" },
            { title: "Кол-во", dataIndex: "quantity", align: "right" },
            {
              title: "В запуске",
              align: "right",
              render: (_, l) =>
                l.launched >= l.quantity - 0.001 ? (
                  <Tag color="blue">{l.launched}</Tag>
                ) : l.launched > 0 ? (
                  <Tag color="orange">
                    {l.launched} из {l.quantity}
                  </Tag>
                ) : (
                  "—"
                ),
            },
            { title: "Примечание", dataIndex: "note", render: (v: string | null) => v ?? "" },
          ]}
        />
        {o.production_orders.length > 0 && (
          <Space wrap style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">Заказы на производство:</Typography.Text>
            {o.production_orders.map((p) => (
              <Link key={p.id} to={`/production-orders/${p.id}`}>
                №{p.id} «{p.name}» · {ORDER_STATUS_LABEL[p.status as OrderStatus] ?? p.status}
              </Link>
            ))}
          </Space>
        )}
      </Card>

      {editing && <CustomerOrderModal order={o} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {moving && <MoveDatesModal order={o} onClose={() => setMoving(false)} />}
    </Space>
  );
}
