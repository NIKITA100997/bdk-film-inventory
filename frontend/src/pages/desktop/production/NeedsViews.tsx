import { useMemo, useState } from "react";
import { Alert, Button, Card, InputNumber, Modal, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { getCustomerOrderNeeds, getNeedsOverview, getOrderNeeds, purchaseShortages, type NeedRow, type ShortageRow } from "../../../api/needs";
import { useAuth } from "../../../auth/AuthContext";
import { apiErrorMessage } from "../../../utils/apiError";
import { hasPerm } from "../../../auth/permissions";

const d = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM") : "—");
const n = (v: number) => (Math.round(v * 10) / 10).toLocaleString("ru-RU");

function useCanPurchase() {
  const { user } = useAuth();
  return hasPerm(user, "production_tasks.manage", "purchasing.manage");
}

function reportPurchase(r: { film_requests: number[]; bitrix_tasks: number; not_sent: string[] }) {
  const parts = [];
  if (r.film_requests.length) parts.push(`заявок на плёнку: ${r.film_requests.length}`);
  if (r.bitrix_tasks) parts.push(`задач закупщику в Битрикс24: ${r.bitrix_tasks}`);
  if (parts.length) message.success(`Создано — ${parts.join(", ")}`);
  if (r.not_sent.length)
    Modal.info({
      title: "Материалы не отправлены — Битрикс24 не подключён",
      content: (
        <Space direction="vertical">
          <Typography.Text>Передайте закупщику:</Typography.Text>
          {r.not_sent.map((t) => (
            <Typography.Text key={t} copyable>
              {t}
            </Typography.Text>
          ))}
        </Space>
      ),
    });
}

/** Потребность заказа (12.10): плёнка и материалы с учётом очереди заказов —
 * склад сначала отдан тем, кто впереди. Дефицит — заказать одной кнопкой. */
export function OrderNeedsCard({ orderId, customer = false }: { orderId: number; customer?: boolean }) {
  const qc = useQueryClient();
  const canPurchase = useCanPurchase();
  const q = useQuery({
    queryKey: ["order-needs", customer ? "co" : "po", orderId],
    queryFn: () => (customer ? getCustomerOrderNeeds(orderId) : getOrderNeeds(orderId)),
  });
  const data = q.data;
  const short = (data?.rows ?? []).filter((r) => r.shortage > 0.001);
  const buy = useMutation({
    mutationFn: () =>
      purchaseShortages(
        short.map((r) => ({
          key: r.key,
          qty: Math.ceil(r.shortage),
          need_by: r.need_by,
          order_ids: customer ? [] : [orderId],
          labels: customer && data ? [data.name] : undefined,
        })),
      ),
    onSuccess: (r) => {
      reportPurchase(r);
      qc.invalidateQueries({ queryKey: ["order-needs"] });
      qc.invalidateQueries({ queryKey: ["needs"] });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать заявки")),
  });
  if (q.isLoading || !data) return null;
  return (
    <Card
      size="small"
      title={
        <Space wrap>
          Потребность
          {short.length ? <Tag color="red">дефицит: {short.length}</Tag> : <Tag color="green">всего хватает</Tag>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            в очереди: {data.group}; склад сначала отдан заказам впереди
          </Typography.Text>
        </Space>
      }
      extra={
        canPurchase &&
        short.length > 0 && (
          <Button loading={buy.isPending} onClick={() => buy.mutate()}>
            Заказать дефицит
          </Button>
        )
      }
    >
      {data.error && <Alert type="warning" showIcon message={data.error} style={{ marginBottom: 8 }} />}
      {data.fg.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message="Есть готовые на складе ГП без заказа"
          description={data.fg.map((f) => `${f.name}: свободно ${f.free} из нужных ${f.need}`).join("; ")}
        />
      )}
      <NeedTable rows={data.rows} />
    </Card>
  );
}

function NeedTable({ rows }: { rows: NeedRow[] }) {
  return (
    <Table<NeedRow>
      size="small"
      rowKey="key"
      pagination={false}
      dataSource={rows}
      locale={{ emptyText: "Плёнки и материалов по составу не нужно" }}
      columns={[
        { title: "Что", render: (_, r) => <Space size={4}>{r.kind === "film" ? <Tag>плёнка</Tag> : <Tag color="blue">материал</Tag>}{r.name}</Space> },
        { title: "Нужно", align: "right", render: (_, r) => `${n(r.need)} ${r.unit}` },
        { title: "Со склада", align: "right", render: (_, r) => n(r.allocated) },
        { title: "Поставка", align: "right", render: (_, r) => (r.incoming ? `${n(r.incoming)} к ${d(r.incoming_date)}` : "—") },
        {
          title: "Дефицит",
          align: "right",
          render: (_, r) => (r.shortage > 0.001 ? <Typography.Text type="danger" strong>{n(r.shortage)} {r.unit}</Typography.Text> : "—"),
        },
        { title: "Нужно к", render: (_, r) => d(r.need_by) },
      ]}
    />
  );
}

/** Дефицит по всем заказам (12.10): чего не хватает, к какому дню, под
 * какие заказы; выбрать и заказать — плёнка в заявки на закупку, материалы
 * задачей закупщику в Битрикс24. */
export function ShortagesTab() {
  const qc = useQueryClient();
  const canPurchase = useCanPurchase();
  const q = useQuery({ queryKey: ["needs"], queryFn: getNeedsOverview });
  const rows = useMemo(() => q.data?.shortages ?? [], [q.data]);
  const [picked, setPicked] = useState<string[]>([]);
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const buy = useMutation({
    mutationFn: () =>
      purchaseShortages(
        rows
          .filter((r) => picked.includes(r.key))
          .map((r) => ({
            key: r.key,
            qty: qty[r.key] ?? Math.ceil(r.shortage),
            need_by: r.need_by,
            order_ids: r.orders.filter((o) => !o.customer_order_id).map((o) => o.order_id),
            labels: r.orders.map((o) => (o.customer_order_id ? o.name : `№${o.order_id}`)),
          })),
      ),
    onSuccess: (r) => {
      reportPurchase(r);
      setPicked([]);
      qc.invalidateQueries({ queryKey: ["needs"] });
      qc.invalidateQueries({ queryKey: ["order-needs"] });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать заявки")),
  });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        По всем открытым заказам: запущенные, принятые и отправленные заявки, черновики с датой. Склад отдаётся по очереди — сначала
        запущенные, потом принятые, потом заявки; внутри — срочные раньше, потом по дате. Открытая заявка на плёнку с датой поставки
        закрывает дефицит, если успевает.
      </Typography.Paragraph>
      {canPurchase && (
        <Space>
          <Button type="primary" disabled={!picked.length} loading={buy.isPending} onClick={() => buy.mutate()}>
            Заказать выбранное ({picked.length})
          </Button>
          <Typography.Text type="secondary">плёнка — в «Заявки на закупку», материалы — задачей закупщику в Битрикс24</Typography.Text>
        </Space>
      )}
      <Table<ShortageRow>
        size="small"
        rowKey="key"
        loading={q.isLoading}
        pagination={false}
        dataSource={rows}
        locale={{ emptyText: "Дефицита нет" }}
        rowSelection={canPurchase ? { selectedRowKeys: picked, onChange: (k) => setPicked(k as string[]) } : undefined}
        expandable={{
          expandedRowRender: (r) => (
            <Space direction="vertical" size={2}>
              {r.orders.map((o) => (
                <span key={o.order_id}>
                  {o.customer_order_id ? (
                    <Link to={`/customer-orders/${o.customer_order_id}`}>{o.name}</Link>
                  ) : (
                    <Link to={`/production-orders/${o.order_id}`}>
                      №{o.order_id} «{o.name}»
                    </Link>
                  )}{" "}
                  <Tag>{o.group}</Tag> {n(o.shortage)} {r.unit}, нужно к {d(o.need_by)}
                </span>
              ))}
            </Space>
          ),
        }}
        columns={[
          { title: "Что", render: (_, r) => <Space size={4}>{r.kind === "film" ? <Tag>плёнка</Tag> : <Tag color="blue">материал</Tag>}{r.name}</Space> },
          { title: "Дефицит", align: "right", render: (_, r) => <Typography.Text type="danger" strong>{n(r.shortage)} {r.unit}</Typography.Text> },
          { title: "Нужно к", render: (_, r) => d(r.need_by) },
          { title: "Заказов", align: "right", render: (_, r) => r.orders.length },
          {
            title: "Заказать",
            render: (_, r) => (
              <InputNumber
                size="small"
                min={0}
                style={{ width: 110 }}
                value={qty[r.key] ?? Math.ceil(r.shortage)}
                onChange={(v) => setQty({ ...qty, [r.key]: v })}
                addonAfter={r.unit}
              />
            ),
          },
        ]}
      />
    </Space>
  );
}
