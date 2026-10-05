import { useMemo, useState } from "react";
import dayjs from "dayjs";
import { Card, Checkbox, Input, Progress, Segmented, Space, Table, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  getInvoicesReadiness,
  getOrdersReadiness,
  type InvoiceReadiness,
  type OrderReadiness,
  type ReadinessStage,
} from "../../api/productionOrders";
import ResponsiveTable from "../../components/ResponsiveTable";

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Готовность заказов для продажника: когда будет готово по плану, успевает
 * ли к отгрузке и сколько сделано по позициям — без цеховых подробностей
 * (задания, участки). План — из планировщика (сроки назад от отгрузки). */
export default function OrderReadiness() {
  // Продажнику важнее счёт клиента: в одном запуске двери разных счетов,
  // один счёт бывает в разных запусках.
  const [by, setBy] = useState<"invoice" | "order">("invoice");
  const [q, setQ] = useState("");
  const [withClosed, setWithClosed] = useState(false);
  const [onlyRisk, setOnlyRisk] = useState(false);
  const query = useQuery({ queryKey: ["order-readiness", withClosed], queryFn: () => getOrdersReadiness(withClosed) });
  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return (query.data ?? []).filter(
      (o) =>
        (!needle || norm(o.name).includes(needle) || String(o.id) === needle.replace("№", "") || o.lines.some((l) => norm(l.item_name).includes(needle))) &&
        (!onlyRisk || o.plan_late || o.plan_overdue > 0),
    );
  }, [query.data, q, onlyRisk]);
  const risky = (query.data ?? []).filter((o) => o.plan_late || o.plan_overdue > 0).length;
  // Колонки этапов — общие для показанных заказов, по порядку маршрута.
  const stageCols = useMemo(() => {
    const seq = new Map<string, number>();
    for (const o of rows) for (const st of o.stages) seq.set(st.name, Math.max(seq.get(st.name) ?? -Infinity, st.seq));
    return [...seq.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], "ru")).map(([name]) => name);
  }, [rows]);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card title="Готовность заказов">
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            Счёт (или заказ) — строка, этапы — колонки: готово, в работе (сколько из скольких и до какого дня), запланировано на
            день или просрочено. Справа — когда заказ будет готов по плану и успевает ли к отгрузке. Раскройте строку —
            готовность по позициям.
          </Typography.Text>
          <Space wrap>
            <Segmented
              value={by}
              onChange={(v) => setBy(v as "invoice" | "order")}
              options={[
                { value: "invoice", label: "По счетам" },
                { value: "order", label: "По заказам" },
              ]}
            />
            <Input.Search
              allowClear
              placeholder={by === "invoice" ? "Счёт, заказ или позиция" : "Заказ, № или позиция"}
              style={{ width: 300 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Checkbox checked={onlyRisk} onChange={(e) => setOnlyRisk(e.target.checked)}>
              Только с риском{risky ? ` (${risky})` : ""}
            </Checkbox>
            <Checkbox checked={withClosed} onChange={(e) => setWithClosed(e.target.checked)}>
              С закрытыми
            </Checkbox>
          </Space>
        </Space>
      </Card>
      {by === "invoice" ? (
        <InvoiceTable q={q} withClosed={withClosed} onlyRisk={onlyRisk} />
      ) : (
      <ResponsiveTable<OrderReadiness>
        exportTitle="Готовность к отгрузке — по заказам"
        cardBreakpoint="xs"
        size="small"
        rowKey="id"
        loading={query.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 30, hideOnSinglePage: true }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Заказов в производстве нет" }}
        expandable={{
          expandedRowRender: (o) => (
            <Table
              size="small"
              rowKey={(_, i) => String(i)}
              pagination={false}
              dataSource={o.lines}
              columns={[
                { title: "Позиция", dataIndex: "item_name" },
                { title: "Заказано", render: (_, l) => fmt(l.quantity) },
                { title: "Готово", render: (_, l) => fmt(l.done) },
                {
                  title: "",
                  render: (_, l) => (
                    <Progress percent={l.quantity ? Math.round((l.done / l.quantity) * 100) : 0} size="small" style={{ width: 140 }} />
                  ),
                },
              ]}
            />
          ),
        }}
        columns={[
          { title: "Заказ", fixed: "left", render: (_, o) => `№${o.id} «${o.name}»` },
          {
            title: "Отгрузка",
            sorter: (a, b) => (a.ship_date ?? "9").localeCompare(b.ship_date ?? "9"),
            render: (_, o) => (o.ship_date ? dayjs(o.ship_date).format("DD.MM.YYYY") : "—"),
          },
          ...stageCols.map((name) => ({
            title: name,
            render: (_: unknown, o: OrderReadiness) => <StageCell stage={o.stages.find((s) => s.name === name)} />,
          })),
          {
            title: "Готово по плану",
            render: (_, o) =>
              !o.planned ? (
                <Tag>без плана</Tag>
              ) : (
                <Space size={4} wrap>
                  {o.plan_finish && <span>{dayjs(o.plan_finish).format("DD.MM.YYYY")}</span>}
                  {o.plan_late ? <Tag color="red">не успевает к отгрузке</Tag> : <Tag color="green">успевает</Tag>}
                  {o.plan_overdue > 0 && <Tag color="orange">отставание {fmt(o.plan_overdue)} шт</Tag>}
                </Space>
              ),
          },
          {
            title: "Сделано",
            render: (_, o) => (
              <Space size={8}>
                <Progress percent={o.quantity ? Math.round((o.done / o.quantity) * 100) : 0} size="small" style={{ width: 120 }} />
                <span>
                  {fmt(o.done)} из {fmt(o.quantity)}
                </span>
              </Space>
            ),
          },
          { title: "Статус", render: (_, o) => (o.status === "closed" ? <Tag>закрыт</Tag> : <Tag color="blue">в производстве</Tag>) },
        ]}
      />
      )}
    </Space>
  );
}

/** Готовность по счетам 1С: строка — счёт (во всех запусках), этапы —
 * колонки, срок по плану и «успевает ли» к отгрузке. */
function InvoiceTable({ q, withClosed, onlyRisk }: { q: string; withClosed: boolean; onlyRisk: boolean }) {
  const query = useQuery({ queryKey: ["invoice-readiness", withClosed], queryFn: () => getInvoicesReadiness(withClosed) });
  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return (query.data ?? []).filter(
      (o) =>
        (!needle ||
          norm(o.invoice).includes(needle) ||
          o.orders.some((x) => norm(x).includes(needle)) ||
          o.lines.some((l) => norm(l.item_name).includes(needle))) &&
        (!onlyRisk || o.plan_late || o.plan_overdue > 0),
    );
  }, [query.data, q, onlyRisk]);
  const stageCols = useMemo(() => {
    const seq = new Map<string, number>();
    for (const o of rows) for (const st of o.stages) seq.set(st.name, Math.max(seq.get(st.name) ?? -Infinity, st.seq));
    return [...seq.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], "ru")).map(([name]) => name);
  }, [rows]);
  return (
    <ResponsiveTable<InvoiceReadiness>
      exportTitle="Готовность к отгрузке — по счетам"
      cardBreakpoint="xs"
      size="small"
      rowKey="invoice"
      loading={query.isLoading}
      dataSource={rows}
      pagination={{ pageSize: 30, hideOnSinglePage: true }}
      scroll={{ x: "max-content" }}
      locale={{ emptyText: "Счетов в производстве нет" }}
      expandable={{
        expandedRowRender: (o) => (
          <Table
            size="small"
            rowKey={(_, i) => String(i)}
            pagination={false}
            dataSource={o.lines}
            columns={[
              { title: "Позиция", dataIndex: "item_name" },
              { title: "Заказано", render: (_, l) => fmt(l.quantity) },
              { title: "Готово", render: (_, l) => fmt(l.done) },
              {
                title: "",
                render: (_, l) => <Progress percent={l.quantity ? Math.round((l.done / l.quantity) * 100) : 0} size="small" style={{ width: 140 }} />,
              },
            ]}
          />
        ),
      }}
      columns={[
        {
          title: "Счёт",
          fixed: "left",
          render: (_, o) => (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{o.invoice}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {o.orders.join(", ")}
              </Typography.Text>
            </Space>
          ),
        },
        {
          title: "Отгрузка",
          sorter: (a, b) => (a.ship_date ?? "9").localeCompare(b.ship_date ?? "9"),
          render: (_, o) => (o.ship_date ? dayjs(o.ship_date).format("DD.MM.YYYY") : "—"),
        },
        ...stageCols.map((name) => ({
          title: name,
          render: (_: unknown, o: InvoiceReadiness) => <StageCell stage={o.stages.find((s) => s.name === name)} />,
        })),
        {
          title: "Готово по плану",
          render: (_, o) =>
            !o.planned ? (
              <Tag>без плана</Tag>
            ) : (
              <Space size={4} wrap>
                {o.plan_finish && <span>{dayjs(o.plan_finish).format("DD.MM.YYYY")}</span>}
                {o.plan_late ? <Tag color="red">не успевает к отгрузке</Tag> : <Tag color="green">успевает</Tag>}
                {o.plan_overdue > 0 && <Tag color="orange">отставание {fmt(o.plan_overdue)} шт</Tag>}
              </Space>
            ),
        },
        {
          title: "Сделано",
          render: (_, o) => (
            <Space size={8}>
              <Progress percent={o.quantity ? Math.round((o.done / o.quantity) * 100) : 0} size="small" style={{ width: 120 }} />
              <span>
                {fmt(o.done)} из {fmt(o.quantity)}
              </span>
            </Space>
          ),
        },
        { title: "Статус", render: (_, o) => (o.closed ? <Tag>закрыт</Tag> : <Tag color="blue">в производстве</Tag>) },
      ]}
    />
  );
}

/** Статус этапа: готово / в работе N из M до дня / на день / просрочено. */
function StageCell({ stage }: { stage: ReadinessStage | undefined }) {
  if (!stage) return <Typography.Text type="secondary">—</Typography.Text>;
  const d = stage.plan_date ? dayjs(stage.plan_date).format("DD.MM") : null;
  const part = `${fmt(stage.done)}/${fmt(stage.plan)}`;
  if (stage.status === "done") return <Tag color="green">✓ готово</Tag>;
  if (stage.status === "overdue")
    return (
      <Tag color="red">
        просрочено{d ? ` · ${d}` : ""} · {part}
      </Tag>
    );
  if (stage.status === "progress")
    return (
      <Tag color="blue">
        {part}
        {d ? ` · до ${d}` : ""}
      </Tag>
    );
  if (stage.status === "planned") return <Tag>{d ?? "в плане"}</Tag>;
  return <Typography.Text type="secondary">без плана</Typography.Text>;
}
