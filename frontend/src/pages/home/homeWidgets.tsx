import { Button, Empty, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { apiClient } from "../../api/client";
import { STAGE_COLOR, listCustomerOrders, submitCustomerOrder, type CustomerOrder } from "../../api/customerOrders";
import { useAuth } from "../../auth/AuthContext";
import { apiErrorMessage } from "../../utils/apiError";

const n = (v: number) => v.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const d = (v: string | null) => (v ? dayjs(v).format("DD.MM") : "—");

interface AreaWeek {
  week_start: string;
  planned: number;
  capacity: number | null;
  load_pct: number | null;
}

interface AreaLoad {
  area: string;
  name: string;
  queue_pieces: number;
  per_day: number | null;
  per_day_source: "set" | "fact" | null;
  days: number | null;
  free_from: string | null;
  overdue: number;
  unplanned: number;
  weeks: AreaWeek[];
}

const loadColor = (pct: number) => (pct > 100 ? "#C0392B" : pct >= 80 ? "#D46B08" : "#1D9E75");

/** Загрузка участков по неделям (28.10): разложенное в плане против мощности
 * недели — зелёный до 80 %, оранжевый до 100 %, красный — перегруз;
 * отдельно отставание и то, что ещё не разложено по дням. */
export function AreaLoadWidget() {
  const q = useQuery({ queryKey: ["area-load"], queryFn: async () => (await apiClient.get<AreaLoad[]>("/area-load")).data, refetchInterval: 300_000 });
  const rows = q.data ?? [];
  const weeks = rows[0]?.weeks?.map((w) => w.week_start) ?? [];
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Table<AreaLoad>
        size="small"
        rowKey="area"
        loading={q.isLoading}
        pagination={false}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Открытых заданий нет" }}
        columns={[
          {
            title: "Участок",
            fixed: "left",
            render: (_, r) => (
              <Space direction="vertical" size={0}>
                <span>{r.name}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {r.per_day == null ? "мощность не задана" : `${n(r.per_day)} шт/день${r.per_day_source === "fact" ? " по факту" : ""}`}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "Отстаёт",
            align: "right",
            render: (_, r) => ((r.overdue ?? 0) > 0 ? <Tag color="red">{n(r.overdue)}</Tag> : <Typography.Text type="secondary">—</Typography.Text>),
          },
          ...weeks.map((wk, i) => ({
            title: i === 0 ? "Эта неделя" : `с ${d(wk)}`,
            key: wk,
            render: (_: unknown, r: AreaLoad) => {
              const w = r.weeks?.[i];
              if (!w || (!w.planned && w.capacity == null)) return <Typography.Text type="secondary">—</Typography.Text>;
              if (w.load_pct == null) return <span>{n(w.planned)}</span>;
              const pct = Math.min(w.load_pct, 150);
              return (
                <div title={`в плане ${n(w.planned)} из ${n(w.capacity ?? 0)} шт`} style={{ minWidth: 92 }}>
                  <div style={{ height: 8, background: "rgba(0,0,0,0.06)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${(pct / 150) * 100}%`, height: "100%", background: loadColor(w.load_pct) }} />
                  </div>
                  <span style={{ fontSize: 12, color: loadColor(w.load_pct), fontWeight: 600 }}>{w.load_pct}%</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}> {n(w.planned)}</Typography.Text>
                </div>
              );
            },
          })),
          {
            title: "Без плана",
            align: "right",
            render: (_, r) => ((r.unplanned ?? 0) > 0 ? <Tag color="gold">{n(r.unplanned)}</Tag> : <Typography.Text type="secondary">—</Typography.Text>),
          },
          {
            title: "Освободится",
            render: (_, r) => (r.free_from ? <span>{d(r.free_from)} <Typography.Text type="secondary">({r.days} р.д.)</Typography.Text></span> : "—"),
          },
        ]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Неделя — разложенное в плане и ещё не сделанное против мощности (в день × рабочие дни): зелёный до 80 %, оранжевый до 100 %, красный —
        перегруз. «Без плана» — задания, ещё не разложенные по дням, «Отстаёт» — план прошедших дней не сделан.
      </Typography.Text>
    </Space>
  );
}

const WAIT = new Set(["draft", "returned"]);

/** Мои заказы (28.10, менеджер): незакрытые заказы покупателей, где я
 * менеджер; черновик — «Отправить в производство» прямо в строке. */
export function MyOrdersWidget() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["customer-orders", false], queryFn: () => listCustomerOrders(false) });
  const mine = (q.data ?? [])
    .filter((o) => o.manager_id === user?.id)
    .sort((a, b) => Number(WAIT.has(b.status)) - Number(WAIT.has(a.status)) || b.created_at.localeCompare(a.created_at));
  const send = useMutation({
    mutationFn: (o: CustomerOrder) => submitCustomerOrder(o.id, null),
    onSuccess: (o) => {
      message.success(`${o.invoice_no} — отправлен в производство`);
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не отправился")),
  });
  if (!q.isLoading && !mine.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Своих открытых заказов нет" />;
  return (
    <Table<CustomerOrder>
      size="small"
      rowKey="id"
      loading={q.isLoading}
      dataSource={mine}
      pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
      columns={[
        {
          title: "Счёт",
          render: (_, o) => (
            <Space direction="vertical" size={0}>
              <Link to={`/customer-orders/${o.id}`}><b>{o.invoice_no}</b></Link>
              {o.customer && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{o.customer}</Typography.Text>}
            </Space>
          ),
        },
        { title: "Стадия", render: (_, o) => <Tag color={STAGE_COLOR[o.stage]}>{o.stage_label}</Tag> },
        { title: "Шт", align: "right", render: (_, o) => n(o.qty) },
        {
          title: "Отгрузка",
          render: (_, o) => (o.ship_date ? d(o.ship_date) : o.ship_to ? `вилка до ${d(o.ship_to)}` : <Typography.Text type="secondary">не задана</Typography.Text>),
        },
        {
          title: "",
          render: (_, o) =>
            WAIT.has(o.status) ? (
              <Space direction="vertical" size={0}>
                <Button size="small" type="primary" loading={send.isPending && send.variables?.id === o.id} onClick={() => send.mutate(o)}>
                  Отправить в производство
                </Button>
                {o.status === "returned" && o.request_comment && (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>вернули: {o.request_comment}</Typography.Text>
                )}
              </Space>
            ) : null,
        },
      ]}
    />
  );
}

interface OverdueLine {
  task_id: number;
  task_name: string;
  area: string;
  area_name: string;
  line_id: number;
  part_name: string;
  since: string;
  overdue: number;
  workdays_late: number;
}

/** Отставание (28.10): строки заданий, где план прошедших дней не сделан —
 * по участкам, самые давние первыми; строка ведёт в задание. */
export function OverdueWidget() {
  const q = useQuery({ queryKey: ["planning-overdue"], queryFn: async () => (await apiClient.get<OverdueLine[]>("/planning/overdue")).data, refetchInterval: 300_000 });
  const rows = q.data ?? [];
  if (q.isError) return <Typography.Text type="danger">Не удалось посчитать отставание — обновите страницу.</Typography.Text>;
  if (!q.isLoading && !rows.length)
    return <Typography.Text type="success">Отставания нет — план прошедших дней выполнен.</Typography.Text>;
  const byArea = new Map<string, { name: string; lines: number; qty: number }>();
  for (const r of rows) {
    const a = byArea.get(r.area) ?? { name: r.area_name, lines: 0, qty: 0 };
    a.lines += 1;
    a.qty += r.overdue;
    byArea.set(r.area, a);
  }
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Space wrap size={[6, 6]}>
        {[...byArea.values()].sort((a, b) => b.qty - a.qty).map((a) => (
          <Tag key={a.name} color="red">
            {a.name}: {a.lines} стр., {n(a.qty)} шт
          </Tag>
        ))}
      </Space>
      <Table<OverdueLine>
        size="small"
        rowKey="line_id"
        loading={q.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
        columns={[
          { title: "С какого дня", render: (_, r) => <Tag color={r.workdays_late > 5 ? "red" : "orange"}>{d(r.since)} · {r.workdays_late} р.д.</Tag> },
          { title: "Участок", dataIndex: "area_name" },
          { title: "Деталь / работа", render: (_, r) => <Link to={`/production-tasks?tab=tasks&task=${r.task_id}`}>{r.part_name}</Link> },
          { title: "Не сделано, шт", align: "right", render: (_, r) => <b>{n(r.overdue)}</b> },
        ]}
      />
    </Space>
  );
}

interface Delivery {
  id: number;
  material: string | null;
  color: string | null;
  thickness: number | null;
  item_name?: string | null;
  requested_area_m2: number | null;
  quantity?: number | null;
  unit?: string | null;
  supplier: string | null;
  promised_delivery_date: string | null;
  order_id: number | null;
  status: string;
}

/** Ожидаемые поставки (28.10): открытые заявки, уже заказанные поставщику, —
 * по обещанной дате; просроченные — красным, без даты — в конце. */
export function DeliveriesWidget() {
  const q = useQuery({ queryKey: ["purchase-requests", "open"], queryFn: async () => (await apiClient.get<Delivery[]>("/purchase-requests", { params: { status_filter: "open" } })).data });
  const today = dayjs().format("YYYY-MM-DD");
  const rows = (q.data ?? [])
    .filter((r) => r.status === "open" && r.order_id)
    .sort((a, b) => (a.promised_delivery_date ?? "9999").localeCompare(b.promised_delivery_date ?? "9999"));
  const waitingOrder = (q.data ?? []).filter((r) => r.status === "open" && !r.order_id).length;
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {waitingOrder > 0 && (
        <Typography.Text type="warning">
          Ещё {waitingOrder} заявок не заказаны поставщику — <Link to="/purchasing">объединить в заказ</Link>
        </Typography.Text>
      )}
      <Table<Delivery>
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={rows}
        locale={{ emptyText: "Заказанных и ещё не пришедших поставок нет" }}
        pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
        columns={[
          {
            title: "Когда",
            render: (_, r) =>
              !r.promised_delivery_date ? <Typography.Text type="secondary">дата не названа</Typography.Text> : (
                <Tag color={r.promised_delivery_date < today ? "red" : r.promised_delivery_date === today ? "gold" : "blue"}>
                  {r.promised_delivery_date < today ? "опаздывает · " : ""}{d(r.promised_delivery_date)}
                </Tag>
              ),
          },
          { title: "Что", render: (_, r) => r.item_name ?? [r.material, r.color, r.thickness ? `${r.thickness} мм` : null].filter(Boolean).join(" ") },
          { title: "Сколько", align: "right", render: (_, r) => (r.quantity != null ? `${n(r.quantity)} ${r.unit ?? ""}` : r.requested_area_m2 != null ? `${n(r.requested_area_m2)} м²` : "—") },
          { title: "Поставщик", render: (_, r) => r.supplier ?? "—" },
          { title: "Заказ", render: (_, r) => (r.order_id ? `№${r.order_id}` : "—") },
        ]}
      />
    </Space>
  );
}
