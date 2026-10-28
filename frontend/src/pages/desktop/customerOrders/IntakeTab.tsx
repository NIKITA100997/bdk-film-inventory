import { useMemo, useState } from "react";
import { Alert, Button, Card, Checkbox, DatePicker, Input, Modal, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  acceptManyCustomerOrders,
  getCustomerIntakeNeeds,
  getIntakeLoad,
  getCustomerPlanCheck,
  listCustomerOrders,
  returnManyCustomerOrders,
  type CustomerOrder,
} from "../../../api/customerOrders";
import { apiErrorMessage } from "../../../utils/apiError";
import { PlanCheckView, fmt } from "./parts";

const WAITING = ["submitted", "draft", "returned"] as const;
const STATUS: Record<string, { label: string; color: string }> = {
  submitted: { label: "отправлен", color: "red" },
  draft: { label: "черновик", color: "default" },
  returned: { label: "возвращён", color: "orange" },
};
type StatusFilter = "all" | (typeof WAITING)[number];

const n = (v: number) => v.toLocaleString("ru-RU", { maximumFractionDigits: 2 });

/** Сколько штук по видам: «Щитовая дверь 40 · Погонаж 120». */
function byKind(orders: CustomerOrder[]): [string, number][] {
  const m = new Map<string, number>();
  for (const o of orders) for (const l of o.lines) m.set(l.kind_name || "прочее", (m.get(l.kind_name || "прочее") ?? 0) + l.quantity - l.launched);
  return [...m.entries()].filter(([, q]) => q > 0.001).sort((a, b) => b[1] - a[1]);
}

/** Приём в производство (28.10): заказы клиентов, которые ждут приёма —
 * отправленные, черновики менеджеров, возвращённые. Состав и что нужно
 * заказу видно в строке, принимаются и возвращаются сразу несколько. */
export default function IntakeTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["customer-orders", false], queryFn: () => listCustomerOrders(false) });
  const [status, setStatus] = useState<StatusFilter>("all");
  const [manager, setManager] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [accepting, setAccepting] = useState(false);
  const [returning, setReturning] = useState(false);

  const waiting = useMemo(
    () =>
      (q.data ?? [])
        .filter((o) => (WAITING as readonly string[]).includes(o.status) && o.lines.length > 0)
        .sort((a, b) => WAITING.indexOf(a.status as never) - WAITING.indexOf(b.status as never) || b.created_at.localeCompare(a.created_at)),
    [q.data],
  );
  const managers = [...new Set(waiting.map((o) => o.manager_name).filter(Boolean))] as string[];
  const s = search.trim().toLowerCase();
  const rows = waiting.filter(
    (o) =>
      (status === "all" || o.status === status) &&
      (!manager || o.manager_name === manager) &&
      (!s || `${o.invoice_no} ${o.customer ?? ""} ${o.lines.map((l) => l.item_name).join(" ")}`.toLowerCase().includes(s)),
  );
  const selected = waiting.filter((o) => picked.includes(o.id));
  const done = () => {
    setPicked([]);
    qc.invalidateQueries({ queryKey: ["customer-orders"] });
    qc.invalidateQueries({ queryKey: ["inbox"] });
  };

  return (
    <Card
      title="Приём в производство"
      extra={
        <Typography.Text type="secondary">
          ждут: {waiting.filter((o) => o.status === "submitted").length} отправленных, {waiting.filter((o) => o.status === "draft").length} черновиков,{" "}
          {waiting.filter((o) => o.status === "returned").length} возвращённых
        </Typography.Text>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space wrap>
          {(["all", ...WAITING] as StatusFilter[]).map((k) => (
            <Tag.CheckableTag key={k} checked={status === k} onChange={() => setStatus(k)} style={{ fontSize: 13, padding: "3px 10px" }}>
              {k === "all" ? "Все" : STATUS[k].label + (k === "submitted" ? "ы" : k === "draft" ? "и" : "ные")}{" "}
              {k === "all" ? waiting.length : waiting.filter((o) => o.status === k).length}
            </Tag.CheckableTag>
          ))}
          <Select allowClear placeholder="Менеджер" style={{ width: 200 }} value={manager} onChange={(v) => setManager(v ?? null)}
            options={managers.map((m) => ({ value: m, label: m }))} />
          <Input.Search allowClear placeholder="Счёт, клиент, позиция" style={{ width: 260 }} onChange={(e) => setSearch(e.target.value)} />
        </Space>

        <Space wrap style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--ant-color-bg-container, #fff)", padding: "6px 0" }}>
          <Button type="primary" disabled={!selected.length} onClick={() => setAccepting(true)}>
            Принять выбранные ({selected.length})
          </Button>
          <Button disabled={!selected.length} onClick={() => setReturning(true)}>
            Вернуть менеджерам…
          </Button>
          {selected.length > 0 && (
            <Typography.Text type="secondary">
              {byKind(selected).map(([k, v]) => `${k} ${n(v)} шт`).join(" · ")}
            </Typography.Text>
          )}
        </Space>

        {selected.length > 0 && <IntakeLoad ids={selected.map((o) => o.id)} />}

        <Table<CustomerOrder>
          size="small"
          rowKey="id"
          loading={q.isLoading}
          dataSource={rows}
          pagination={{ pageSize: 50, showSizeChanger: false }}
          rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as number[]) }}
          expandable={{ expandedRowRender: (o) => <IntakeDetail order={o} />, expandRowByClick: true }}
          columns={[
            {
              title: "Счёт",
              render: (_, o) => (
                <Space direction="vertical" size={0}>
                  <span>
                    <Link to={`/customer-orders/${o.id}`} onClick={(e) => e.stopPropagation()}>
                      <b>{o.invoice_no}</b>
                    </Link>
                    {o.invoice_date && <Typography.Text type="secondary"> от {dayjs(o.invoice_date).format("DD.MM.YY")}</Typography.Text>}
                  </span>
                  {o.customer && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{o.customer}</Typography.Text>}
                </Space>
              ),
            },
            {
              title: "Статус",
              render: (_, o) => (
                <Space direction="vertical" size={0}>
                  <Tag color={STATUS[o.status]?.color}>{STATUS[o.status]?.label}</Tag>
                  {o.status === "returned" && o.request_comment && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{o.request_comment}</Typography.Text>
                  )}
                </Space>
              ),
            },
            { title: "Менеджер", render: (_, o) => o.manager_name ?? "—" },
            {
              title: "Состав",
              render: (_, o) => (
                <Space direction="vertical" size={0}>
                  {byKind([o]).map(([k, v]) => (
                    <span key={k} style={{ whiteSpace: "nowrap" }}>
                      {k} <b>{n(v)}</b>
                    </span>
                  ))}
                </Space>
              ),
            },
            {
              title: "Вилка отгрузки",
              render: (_, o) => (o.ship_from || o.ship_to ? `${fmt(o.ship_from)} – ${fmt(o.ship_to)}` : <Typography.Text type="secondary">не задана</Typography.Text>),
            },
            {
              title: "Появился",
              sorter: (a, b) => a.created_at.localeCompare(b.created_at),
              render: (_, o) => dayjs(o.created_at).format("DD.MM.YY"),
            },
          ]}
        />
      </Space>
      {accepting && <AcceptManyModal orders={selected} onClose={() => setAccepting(false)} onDone={done} />}
      {returning && <ReturnManyModal orders={selected} onClose={() => setReturning(false)} onDone={done} />}
    </Card>
  );
}

/** Строка раскрыта: позиции с исполнением, что нужно заказу (в конце
 * очереди) и когда раньше всего готово. Считается только при раскрытии. */
function IntakeDetail({ order }: { order: CustomerOrder }) {
  const needs = useQuery({ queryKey: ["customer-order", order.id, "intake-needs"], queryFn: () => getCustomerIntakeNeeds(order.id), staleTime: 60_000 });
  const check = useQuery({ queryKey: ["customer-order", order.id, "plan-check"], queryFn: () => getCustomerPlanCheck(order.id), staleTime: 60_000 });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={order.lines.filter((l) => l.quantity - l.launched > 0.001)}
        columns={[
          { title: "Позиция", dataIndex: "item_name" },
          { title: "Вид", dataIndex: "kind_name", render: (v) => v ?? "—" },
          {
            title: "Исполнение",
            render: (_, l) =>
              l.options?.length ? l.options.map((op) => `${op.name.toLowerCase()}: ${op.value}`).join(", ") : <Typography.Text type="secondary">—</Typography.Text>,
          },
          { title: "Шт", align: "right", render: (_, l) => n(l.quantity - l.launched) },
        ]}
      />
      <div>
        <Typography.Text strong>Что нужно</Typography.Text>{" "}
        <Typography.Text type="secondary">— после всего принятого и отправленного: хватит ли того, что останется</Typography.Text>
        {needs.isLoading ? (
          <div><Spin size="small" /> считается…</div>
        ) : needs.error ? (
          <Alert type="error" showIcon message={apiErrorMessage(needs.error, "Не посчиталось")} />
        ) : needs.data?.error ? (
          <Alert type="warning" showIcon message={needs.data.error} />
        ) : (
          <Table
            size="small"
            rowKey="name"
            pagination={false}
            dataSource={needs.data?.rows ?? []}
            locale={{ emptyText: "Плёнка и материалы этому заказу не нужны" }}
            columns={[
              { title: "Что", dataIndex: "name" },
              { title: "Нужно", align: "right", render: (_, r) => `${n(r.need)} ${r.unit}` },
              {
                title: "Хватает?",
                render: (_, r) =>
                  r.shortage > 0.001 ? (
                    <Tag color="red">не хватает {n(r.shortage)} {r.unit}</Tag>
                  ) : r.incoming > 0.001 ? (
                    <Tag color="gold">с поставкой {r.incoming_date ? fmt(r.incoming_date) : ""}</Tag>
                  ) : (
                    <Tag color="green">есть</Tag>
                  ),
              },
            ]}
          />
        )}
        {(needs.data?.fg ?? []).length > 0 && (
          <Alert style={{ marginTop: 8 }} type="info" showIcon
            message={`На складе без заказа: ${needs.data!.fg.map((f) => `${f.name} — ${n(f.free)} шт`).join("; ")} — можно отдать вместо производства`} />
        )}
      </div>
      <div>
        <Typography.Text strong>Когда успеваем</Typography.Text>
        {check.isLoading ? <div><Spin size="small" /> считается…</div> : check.data ? <PlanCheckView check={check.data} shipTo={order.ship_to} /> : null}
      </div>
    </Space>
  );
}

/** Загрузка участков, если принять и запустить выбранные: очередь открытых
 * заданий и сколько добавят выбранные — в рабочих днях при мощности участка. */
function IntakeLoad({ ids }: { ids: number[] }) {
  const key = [...ids].sort((a, b) => a - b);
  const q = useQuery({ queryKey: ["intake-load", key], queryFn: () => getIntakeLoad(key), staleTime: 60_000 });
  const areas = q.data?.areas ?? [];
  const maxDays = Math.max(1, ...areas.map((a) => a.days ?? 0));
  return (
    <Card size="small" title={`Загрузка участков, если принять выбранные (${ids.length})`} loading={q.isLoading}>
      {q.error ? (
        <Alert type="error" showIcon message={apiErrorMessage(q.error, "Не посчиталось")} />
      ) : q.data?.error ? (
        <Alert type="warning" showIcon message={q.data.error} />
      ) : (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            {q.data?.earliest ? (
              <>
                Раньше всего всё выбранное готово к <b>{fmt(q.data.earliest)}</b>
                {q.data.bottleneck ? <> — держит загрузка участка «{q.data.bottleneck}»</> : <> — держат сроки операций по маршруту</>}
              </>
            ) : (
              "Срок не посчитался"
            )}
          </Typography.Text>
          <Table
            size="small"
            rowKey="area"
            pagination={false}
            dataSource={areas}
            columns={[
              { title: "Участок", dataIndex: "name" },
              { title: "В очереди, шт", align: "right", render: (_, a) => n(a.queue_pieces) },
              { title: "+ выбранные, шт", align: "right", render: (_, a) => <b>{n(a.order_pieces)}</b> },
              {
                title: "Мощность в день",
                align: "right",
                render: (_, a) =>
                  a.per_day == null ? (
                    <Typography.Text type="secondary">не задана</Typography.Text>
                  ) : (
                    <>
                      {n(a.per_day)}
                      {a.per_day_source === "fact" && <Typography.Text type="secondary"> по факту</Typography.Text>}
                    </>
                  ),
              },
              {
                title: "Рабочих дней: очередь + выбранные",
                width: 320,
                render: (_, a) =>
                  a.days == null ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    <Space size={8} style={{ width: "100%" }}>
                      <div style={{ display: "flex", width: 200, height: 12, background: "rgba(0,0,0,0.04)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${((a.queue_days ?? 0) / maxDays) * 100}%`, background: "#bfbfbf" }} />
                        <div style={{ width: `${((a.days - (a.queue_days ?? 0)) / maxDays) * 100}%`, background: "#d46b08" }} />
                      </div>
                      <span style={{ whiteSpace: "nowrap" }}>
                        {a.queue_days ?? 0} + {a.days - (a.queue_days ?? 0)} = <b>{a.days}</b>
                      </span>
                    </Space>
                  ),
              },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Очередь — остаток открытых заданий участка. Мощность «по факту» — сколько участок сдавал в рабочий день за 4 недели; задать вручную —
            «Настройки → Участки».
          </Typography.Text>
        </Space>
      )}
    </Card>
  );
}

function AcceptManyModal({ orders, onClose, onDone }: { orders: CustomerOrder[]; onClose: () => void; onDone: () => void }) {
  const navigate = useNavigate();
  const [dates, setDates] = useState<Record<number, { ship: Dayjs | null; ready: Dayjs | null }>>(() =>
    Object.fromEntries(orders.map((o) => {
      const ship = o.ship_to ?? o.ship_from;
      return [o.id, { ship: ship ? dayjs(ship) : null, ready: null }];
    })),
  );
  const [all, setAll] = useState<Dayjs | null>(null);
  const [comment, setComment] = useState("");
  const [launch, setLaunch] = useState(false);
  const [launchName, setLaunchName] = useState("");
  const missing = orders.filter((o) => !dates[o.id]?.ship);
  const m = useMutation({
    mutationFn: () =>
      acceptManyCustomerOrders({
        orders: orders.map((o) => ({
          order_id: o.id,
          ship_date: dates[o.id].ship?.format("YYYY-MM-DD") ?? null,
          ready_date: dates[o.id].ready?.format("YYYY-MM-DD") ?? null,
        })),
        comment: comment.trim() || null,
        launch,
        launch_name: launchName.trim() || null,
      }),
    onSuccess: (r) => {
      message.success(`Принято заказов: ${r.accepted.length}` + (r.production_order_id ? " — собран заказ на производство" : ""));
      onDone();
      onClose();
      if (r.production_order_id) navigate(`/production-orders?order=${r.production_order_id}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось принять")),
  });
  const set = (id: number, k: "ship" | "ready", v: Dayjs | null) => setDates((d) => ({ ...d, [id]: { ...d[id], [k]: v } }));
  return (
    <Modal
      open
      width={860}
      title={`Принять в производство: ${orders.length}`}
      onCancel={onClose}
      okText={launch ? "Принять и собрать запуск" : "Принять"}
      okButtonProps={{ disabled: missing.length > 0, loading: m.isPending }}
      onOk={() => m.mutate()}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space wrap>
          <Typography.Text>Отгрузка всем:</Typography.Text>
          <DatePicker format="DD.MM.YYYY" value={all} onChange={setAll} />
          <Button disabled={!all} onClick={() => setDates((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v, ship: all }])))}>
            Поставить
          </Button>
          <Typography.Text type="secondary">подставлено: конец вилки менеджера</Typography.Text>
        </Space>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={orders}
          scroll={{ y: 360 }}
          columns={[
            { title: "Счёт", render: (_, o) => <b>{o.invoice_no}</b> },
            { title: "Вилка", render: (_, o) => (o.ship_from || o.ship_to ? `${fmt(o.ship_from)} – ${fmt(o.ship_to)}` : "—") },
            {
              title: "Отгрузка",
              render: (_, o) => (
                <DatePicker format="DD.MM.YYYY" status={dates[o.id]?.ship ? undefined : "error"} value={dates[o.id]?.ship} onChange={(v) => set(o.id, "ship", v)} />
              ),
            },
            {
              title: "Готовность",
              render: (_, o) => (
                <DatePicker format="DD.MM.YYYY" placeholder="не обязательно" value={dates[o.id]?.ready} onChange={(v) => set(o.id, "ready", v)}
                  status={dates[o.id]?.ready && dates[o.id]?.ship && dates[o.id].ready!.isAfter(dates[o.id].ship!) ? "error" : undefined} />
              ),
            },
          ]}
        />
        {missing.length > 0 && <Typography.Text type="danger">Нет даты отгрузки: {missing.map((o) => o.invoice_no).join(", ")}</Typography.Text>}
        <Input.TextArea rows={2} maxLength={500} placeholder="Комментарий менеджерам (не обязательно)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <Space wrap>
          <Checkbox checked={launch} onChange={(e) => setLaunch(e.target.checked)}>
            Сразу собрать в запуск — один заказ на производство из всех принятых
          </Checkbox>
          {launch && <Input style={{ width: 280 }} placeholder="Название запуска (не обязательно)" value={launchName} onChange={(e) => setLaunchName(e.target.value)} />}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Менеджерам и в сделки Битрикс24 уйдёт то же, что при «Принять» по одному. Всё или ничего: если у одного заказа ошибка, не примется ни один.
        </Typography.Text>
      </Space>
    </Modal>
  );
}

function ReturnManyModal({ orders, onClose, onDone }: { orders: CustomerOrder[]; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const m = useMutation({
    mutationFn: () => returnManyCustomerOrders(orders.map((o) => o.id), comment.trim()),
    onSuccess: (r) => {
      message.success(`Возвращено менеджерам: ${r.returned.length}`);
      onDone();
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось вернуть")),
  });
  const bad = orders.filter((o) => o.status === "returned");
  return (
    <Modal open title={`Вернуть менеджерам: ${orders.length}`} onCancel={onClose} okText="Вернуть"
      okButtonProps={{ disabled: !comment.trim() || bad.length > 0, loading: m.isPending }} onOk={() => m.mutate()}>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text>{orders.map((o) => o.invoice_no).join(", ")}</Typography.Text>
        {bad.length > 0 && <Typography.Text type="danger">Уже возвращены: {bad.map((o) => o.invoice_no).join(", ")} — снимите с них отметку</Typography.Text>}
        <Input.TextArea autoFocus rows={3} maxLength={500} placeholder="Что не так — увидит менеджер (обязательно)" value={comment} onChange={(e) => setComment(e.target.value)} />
      </Space>
    </Modal>
  );
}
