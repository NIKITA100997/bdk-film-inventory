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

interface AreaLoad {
  area: string;
  name: string;
  queue_pieces: number;
  per_day: number | null;
  per_day_source: "set" | "fact" | null;
  days: number | null;
  free_from: string | null;
}

/** Загрузка участков (28.10): остаток открытых заданий в рабочих днях. */
export function AreaLoadWidget() {
  const q = useQuery({ queryKey: ["area-load"], queryFn: async () => (await apiClient.get<AreaLoad[]>("/area-load")).data, refetchInterval: 300_000 });
  const rows = q.data ?? [];
  const max = Math.max(1, ...rows.map((r) => r.days ?? 0));
  return (
    <Table
      size="small"
      rowKey="area"
      loading={q.isLoading}
      pagination={false}
      dataSource={rows}
      locale={{ emptyText: "Открытых заданий нет" }}
      columns={[
        { title: "Участок", dataIndex: "name" },
        { title: "В очереди, шт", align: "right", render: (_, r) => n(r.queue_pieces) },
        {
          title: "В день",
          align: "right",
          render: (_, r) =>
            r.per_day == null ? <Typography.Text type="secondary">не задана</Typography.Text> : (
              <>
                {n(r.per_day)}
                {r.per_day_source === "fact" && <Typography.Text type="secondary"> по факту</Typography.Text>}
              </>
            ),
        },
        {
          title: "Работы на, раб. дней",
          width: 260,
          render: (_, r) =>
            r.days == null ? "—" : (
              <Space size={8}>
                <div style={{ width: 140, height: 10, background: "rgba(0,0,0,0.05)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${(r.days / max) * 100}%`, height: "100%", background: r.days > 10 ? "#d4380d" : "#d46b08" }} />
                </div>
                <b>{r.days}</b>
                <Typography.Text type="secondary">до {d(r.free_from)}</Typography.Text>
              </Space>
            ),
        },
      ]}
    />
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
