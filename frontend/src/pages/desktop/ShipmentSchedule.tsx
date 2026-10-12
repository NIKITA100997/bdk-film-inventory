import { useMemo, useState } from "react";
import { Button, Card, DatePicker, Empty, Grid, Input, Segmented, Space, Spin, Tag, Tooltip, Typography, theme } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { PRIORITY_COLOR, PRIORITY_LABEL, listProductionOrders, type ProductionOrder } from "../../api/productionOrders";
import { orderTotals } from "./production/ProductionOrders";
import { useAuth } from "../../auth/AuthContext";
import { exportToExcel } from "../../utils/excel";

/** График отгрузок (09.10, «Продажи и заказы»): заказы клиентов и заявки
 * менеджеров по дням. На строке — вилка клиента (светлая полоса), твёрдая
 * отгрузка (блок, цвет — состояние) и «готово по плану» (▲). Сверху — сколько
 * дверей уходит в день. Заказы «на склад» сюда не попадают. */

type State = "shipped" | "late" | "ok" | "noplan" | "accepted" | "submitted" | "returned" | "draft";

const STATE_LABEL: Record<State, string> = {
  shipped: "закрыт",
  late: "не успевает",
  ok: "в работе, успевает",
  noplan: "в работе, без плана",
  accepted: "принят, не запущен",
  submitted: "заявка ждёт решения",
  returned: "заявка возвращена",
  draft: "черновик",
};
const STATE_COLOR: Record<State, string> = {
  shipped: "default",
  late: "red",
  ok: "green",
  noplan: "blue",
  accepted: "cyan",
  submitted: "gold",
  returned: "volcano",
  draft: "default",
};

function stateOf(o: ProductionOrder): State {
  if (o.status === "closed") return "shipped";
  if (o.status === "released") return o.plan_late ? "late" : o.planned ? "ok" : "noplan";
  if (o.request_status === "accepted") return "accepted";
  if (o.request_status === "submitted") return "submitted";
  if (o.request_status === "returned") return "returned";
  return "draft";
}

type Filter = "all" | "requests" | "work" | "shipped";
const FILTERS: [Filter, string, (s: State) => boolean][] = [
  ["all", "Все", () => true],
  ["requests", "Заявки", (s) => s === "submitted" || s === "returned" || s === "accepted" || s === "draft"],
  ["work", "В работе", (s) => s === "late" || s === "ok" || s === "noplan"],
  ["shipped", "Закрытые", (s) => s === "shipped"],
];

const DAY_W = 30;

export default function ShipmentSchedule() {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const LEFT_W = screens.sm ? 300 : 150;
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const [start, setStart] = useState<Dayjs>(() => dayjs().startOf("week").subtract(1, "week"));
  const [weeks, setWeeks] = useState(6);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const ordersQuery = useQuery({ queryKey: ["production-orders", true], queryFn: () => listProductionOrders(true) });

  const days = useMemo(() => Array.from({ length: weeks * 7 }, (_, i) => start.add(i, "day")), [start, weeks]);
  const end = days[days.length - 1];
  const today = dayjs().format("YYYY-MM-DD");
  const needle = q.trim().toLowerCase();

  const rows = useMemo(() => {
    const inRange = (d: string | null | undefined) => !!d && !dayjs(d).isBefore(start, "day") && !dayjs(d).isAfter(end, "day");
    return (ordersQuery.data ?? [])
      .filter((o) => o.kind !== "stock")
      .filter((o) => {
        const from = o.ship_from ?? o.ship_to;
        const windowHits = !!from && !!o.ship_to && !dayjs(o.ship_to).isBefore(start, "day") && !dayjs(from).isAfter(end, "day");
        return inRange(o.ship_date) || windowHits || inRange(o.plan_finish);
      })
      .filter((o) => FILTERS.find((f) => f[0] === filter)![2](stateOf(o)))
      .filter(
        (o) =>
          !needle ||
          `${o.id} ${o.name} ${o.lines.map((l) => `${l.item_name} ${l.invoice_no ?? ""}`).join(" ")} ${o.created_by_name}`
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => (a.ship_date ?? a.ship_from ?? a.ship_to ?? "").localeCompare(b.ship_date ?? b.ship_from ?? b.ship_to ?? ""));
  }, [ordersQuery.data, start, end, filter, needle]);

  // Сколько дверей уходит в день — по твёрдым датам (без заявок, которые ещё ждут).
  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of rows) {
      if (!o.ship_date || o.request_status === "submitted") continue;
      m.set(o.ship_date, (m.get(o.ship_date) ?? 0) + orderTotals(o).qty);
    }
    return m;
  }, [rows]);

  const cellBase = (d: Dayjs): React.CSSProperties => ({
    width: DAY_W,
    minWidth: DAY_W,
    height: 40,
    borderLeft: `1px solid ${token.colorBorderSecondary}`,
    background:
      d.format("YYYY-MM-DD") === today ? token.colorPrimaryBg : d.day() === 0 || d.day() === 6 ? token.colorFillQuaternary : undefined,
    position: "relative",
  });
  const stateBg: Record<State, string> = {
    shipped: token.colorTextQuaternary,
    late: token.colorError,
    ok: token.colorSuccess,
    noplan: token.colorInfo,
    accepted: "#13a8a8",
    submitted: token.colorWarning,
    returned: token.colorError,
    draft: token.colorTextTertiary,
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small" title="График отгрузок">
        <Space wrap size={[12, 8]}>
          <Space size={4}>
            <Button onClick={() => setStart(start.subtract(1, "week"))}>←</Button>
            <DatePicker picker="week" value={start} onChange={(v) => v && setStart(v.startOf("week"))} format="[с] DD.MM.YYYY" allowClear={false} />
            <Button onClick={() => setStart(start.add(1, "week"))}>→</Button>
            <Button onClick={() => setStart(dayjs().startOf("week").subtract(1, "week"))}>Сегодня</Button>
          </Space>
          <Segmented value={weeks} onChange={(v) => setWeeks(v as number)} options={[{ value: 4, label: "4 нед." }, { value: 6, label: "6 нед." }, { value: 10, label: "10 нед." }]} />
          <Segmented value={filter} onChange={(v) => setFilter(v as Filter)} options={FILTERS.map(([value, label]) => ({ value, label }))} />
          <Input.Search allowClear placeholder="№, название, позиция, счёт, менеджер" style={{ width: 300 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Button
            disabled={!rows.length}
            onClick={() =>
              exportToExcel(
                `График отгрузок ${start.format("DD.MM")}-${end.format("DD.MM.YYYY")}`,
                rows.map((o) => {
                  const { qty, done } = orderTotals(o);
                  const f = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "");
                  return {
                    id: o.id, name: o.name, customer: o.customer ?? "", state: STATE_LABEL[stateOf(o)], priority: PRIORITY_LABEL[o.priority ?? 0],
                    window: o.ship_from || o.ship_to ? `${f(o.ship_from)} — ${f(o.ship_to)}` : "", ready: f(o.promised_ready), ship: f(o.ship_date),
                    plan: f(o.plan_finish), qty, done, shipped: o.shipped_qty ?? 0,
                  };
                }),
                [
                  { key: "id", header: "№" }, { key: "name", header: "Заказ" }, { key: "customer", header: "Клиент" },
                  { key: "state", header: "Состояние" }, { key: "priority", header: "Приоритет" }, { key: "window", header: "Вилка" },
                  { key: "ready", header: "Готовность" }, { key: "ship", header: "Отгрузка" }, { key: "plan", header: "По плану" },
                  { key: "qty", header: "Шт" }, { key: "done", header: "Сделано" }, { key: "shipped", header: "Отгружено" },
                ],
              )
            }
          >
            Excel
          </Button>
          <Button onClick={() => window.print()}>Печать</Button>
          {canManage || user?.permissions.includes("orders.request") ? (
            <Button type="primary" onClick={() => navigate("/production-orders")}>
              Новая заявка / заказ →
            </Button>
          ) : null}
        </Space>
        <Space wrap size={[12, 4]} style={{ marginTop: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <span style={{ display: "inline-block", width: 18, height: 10, background: token.colorInfoBg, border: `1px dashed ${token.colorInfoBorder}`, marginRight: 4 }} />
            вилка клиента
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>■ отгрузка (цвет — состояние)</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>◆ обещанная готовность</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>▲ готово по плану</Typography.Text>
          {(Object.keys(STATE_LABEL) as State[]).map((s) => (
            <Tag key={s} color={STATE_COLOR[s]} style={{ marginInlineEnd: 0 }}>
              {STATE_LABEL[s]}
            </Tag>
          ))}
        </Space>
      </Card>

      {ordersQuery.isLoading ? (
        <Spin />
      ) : rows.length === 0 ? (
        <Empty description="В этом периоде отгрузок и заявок нет" />
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadius, background: token.colorBgContainer }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, zIndex: 2, background: token.colorBgContainer, minWidth: LEFT_W, textAlign: "left", padding: "4px 8px" }}>
                  Заказ / заявка
                </th>
                {days.map((d) => (
                  <th
                    key={d.format("YYYY-MM-DD")}
                    style={{ ...cellBase(d), height: "auto", fontWeight: d.date() === 1 || d.day() === 1 ? 600 : 400, padding: "2px 0", textAlign: "center" }}
                  >
                    <div style={{ color: token.colorTextTertiary }}>{["вс", "пн", "вт", "ср", "чт", "пт", "сб"][d.day()]}</div>
                    <div>{d.format(d.date() === 1 ? "D MMM" : "D")}</div>
                  </th>
                ))}
              </tr>
              <tr>
                <td style={{ position: "sticky", left: 0, zIndex: 2, background: token.colorBgContainer, padding: "4px 8px", color: token.colorTextSecondary }}>
                  Отгрузка в день, шт
                </td>
                {days.map((d) => {
                  const n = perDay.get(d.format("YYYY-MM-DD"));
                  return (
                    <td key={d.format("YYYY-MM-DD")} style={{ ...cellBase(d), height: 26, textAlign: "center", fontWeight: 600 }}>
                      {n ? n : ""}
                    </td>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const s = stateOf(o);
                const { qty, done } = orderTotals(o);
                const from = o.ship_from ?? o.ship_to;
                const invoices = [...new Set(o.lines.map((l) => l.invoice_no).filter(Boolean))];
                return (
                  <tr key={o.id} style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, cursor: "pointer" }} onClick={() => navigate(`/production-orders/${o.id}`)}>
                    <td style={{ position: "sticky", left: 0, zIndex: 1, background: token.colorBgContainer, padding: "4px 8px", maxWidth: LEFT_W }}>
                      <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {(o.priority ?? 0) > 0 && (
                          <Tag color={PRIORITY_COLOR[o.priority ?? 0]} style={{ fontSize: 11, lineHeight: "16px", marginInlineEnd: 4 }}>
                            {PRIORITY_LABEL[o.priority ?? 0]}
                          </Tag>
                        )}
                        №{o.id} «{o.name}»{o.customer ? ` · ${o.customer}` : ""}
                      </div>
                      <Space size={4} wrap>
                        <Tag color={STATE_COLOR[s]} style={{ fontSize: 11, lineHeight: "16px", marginInlineEnd: 0 }}>
                          {STATE_LABEL[s]}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {o.status === "draft" ? `${qty} шт` : `${done}/${qty} шт`}
                          {(o.shipped_qty ?? 0) > 0 ? ` · отгружено ${o.shipped_qty}` : ""}
                          {invoices.length ? ` · сч. ${invoices.slice(0, 2).join(", ")}${invoices.length > 2 ? "…" : ""}` : ""}
                        </Typography.Text>
                      </Space>
                    </td>
                    {days.map((d) => {
                      const key = d.format("YYYY-MM-DD");
                      const inWindow = !!from && !!o.ship_to && key >= from && key <= o.ship_to;
                      const isShip = o.ship_date === key && s !== "submitted";
                      const isPlan = o.plan_finish === key && o.status === "released";
                      const isReady = o.promised_ready === key;
                      const tip = [
                        inWindow ? `вилка ${dayjs(from).format("DD.MM")}–${dayjs(o.ship_to).format("DD.MM")}` : null,
                        isShip ? `отгрузка ${dayjs(key).format("DD.MM")}: ${qty} шт` : null,
                        isPlan ? `готово по плану ${dayjs(key).format("DD.MM")}` : null,
                        isReady ? `обещанная готовность ${dayjs(key).format("DD.MM")}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      const cell = (
                        <td
                          key={key}
                          style={{
                            ...cellBase(d),
                            background: inWindow ? token.colorInfoBg : cellBase(d).background,
                            borderTop: inWindow ? `1px dashed ${token.colorInfoBorder}` : undefined,
                            borderBottom: inWindow ? `1px dashed ${token.colorInfoBorder}` : undefined,
                          }}
                        >
                          {isShip && (
                            <div style={{ position: "absolute", inset: "8px 3px", borderRadius: 3, background: stateBg[s] }} />
                          )}
                          {isReady && (
                            <div style={{ position: "absolute", top: 0, left: 0, right: 0, textAlign: "center", fontSize: 10, lineHeight: "11px", color: token.colorText }}>
                              ◆
                            </div>
                          )}
                          {isPlan && (
                            <div
                              style={{
                                position: "absolute",
                                bottom: 1,
                                left: 0,
                                right: 0,
                                textAlign: "center",
                                fontSize: 10,
                                lineHeight: "10px",
                                color: o.plan_late ? token.colorError : token.colorText,
                              }}
                            >
                              ▲
                            </div>
                          )}
                        </td>
                      );
                      return tip ? (
                        <Tooltip key={key} title={tip}>
                          {cell}
                        </Tooltip>
                      ) : (
                        cell
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Space>
  );
}
