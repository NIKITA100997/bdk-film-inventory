import { useMemo, useRef, useState } from "react";
import { Button, Card, DatePicker, Empty, Grid, Input, Segmented, Space, Spin, Tag, Tooltip, Typography, theme } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { listCustomerOrders, type CustomerOrder } from "../../api/customerOrders";
import { PRIORITY_COLOR, PRIORITY_LABEL } from "../../api/productionOrders";
import { exportToExcel } from "../../utils/excel";
import { MoveDatesModal, useCustomerOrderRights } from "./customerOrders/parts";

/** График отгрузок (09.10; с 13.10 — по заказам клиентов). На строке —
 * вилка клиента (светлая полоса), обещанная отгрузка (блок, цвет —
 * состояние), обещанная готовность (◆) и «готово по плану» (▲). Сверху —
 * сколько дверей уходит в день.
 *
 * Перетаскивание: менеджер двигает вилку, пока заказ не принят;
 * производство — отгрузку и готовность (после приёма — с причиной, окно
 * переноса откроется само). */

type State = "shipped" | "late" | "work" | "ready" | "accepted" | "submitted" | "returned" | "draft";

const STATE_LABEL: Record<State, string> = {
  shipped: "отгружен",
  late: "не успевает",
  work: "в производстве",
  ready: "готов / отгружается",
  accepted: "принят, не запущен",
  submitted: "ждёт решения",
  returned: "возвращён",
  draft: "черновик",
};
const STATE_COLOR: Record<State, string> = {
  shipped: "default",
  late: "red",
  work: "blue",
  ready: "green",
  accepted: "cyan",
  submitted: "gold",
  returned: "volcano",
  draft: "default",
};

function stateOf(o: CustomerOrder): State {
  if (o.stage === "shipped") return "shipped";
  if (o.stage === "ready" || o.stage === "shipped_part") return "ready";
  if (o.stage === "in_production") return o.plan_late ? "late" : "work";
  if (o.stage === "accepted" || o.stage === "assembled") return "accepted";
  if (o.stage === "submitted") return "submitted";
  if (o.stage === "returned") return "returned";
  return "draft";
}

type Filter = "all" | "requests" | "work" | "shipped";
const FILTERS: [Filter, string, (s: State) => boolean][] = [
  ["all", "Все", () => true],
  ["requests", "До приёма", (s) => s === "submitted" || s === "returned" || s === "draft"],
  ["work", "Принятые", (s) => s === "accepted" || s === "late" || s === "work" || s === "ready"],
  ["shipped", "Отгруженные", (s) => s === "shipped"],
];

const DAY_W = 30;
type Drag = { id: number; kind: "ship" | "ready" | "window"; from: string };

export default function ShipmentSchedule() {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const LEFT_W = screens.sm ? 300 : 150;
  const navigate = useNavigate();
  const { production, canEdit } = useCustomerOrderRights();
  const [start, setStart] = useState<Dayjs>(() => dayjs().startOf("week").subtract(1, "week"));
  const [weeks, setWeeks] = useState(6);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const ordersQuery = useQuery({ queryKey: ["customer-orders", true], queryFn: () => listCustomerOrders(true) });
  const drag = useRef<Drag | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ order: CustomerOrder; preset: Parameters<typeof MoveDatesModal>[0]["preset"] } | null>(null);

  const days = useMemo(() => Array.from({ length: weeks * 7 }, (_, i) => start.add(i, "day")), [start, weeks]);
  const end = days[days.length - 1];
  const today = dayjs().format("YYYY-MM-DD");
  const needle = q.trim().toLowerCase();

  const rows = useMemo(() => {
    const inRange = (d: string | null | undefined) => !!d && !dayjs(d).isBefore(start, "day") && !dayjs(d).isAfter(end, "day");
    return (ordersQuery.data ?? [])
      .filter((o) => o.status !== "cancelled")
      .filter((o) => {
        const from = o.ship_from ?? o.ship_to;
        const windowHits = !!from && !!o.ship_to && !dayjs(o.ship_to).isBefore(start, "day") && !dayjs(from).isAfter(end, "day");
        return inRange(o.ship_date) || windowHits || inRange(o.plan_finish) || inRange(o.promised_ready);
      })
      .filter((o) => FILTERS.find((f) => f[0] === filter)![2](stateOf(o)))
      .filter(
        (o) =>
          !needle ||
          `${o.invoice_no} ${o.customer ?? ""} ${o.lines.map((l) => l.item_name).join(" ")} ${o.manager_name ?? ""}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => (a.ship_date ?? a.ship_from ?? a.ship_to ?? "").localeCompare(b.ship_date ?? b.ship_from ?? b.ship_to ?? ""));
  }, [ordersQuery.data, start, end, filter, needle]);

  // Сколько дверей уходит в день — по обещанным отгрузкам принятых заказов.
  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of rows) {
      if (!o.ship_date || o.status !== "accepted" || o.stage === "shipped") continue;
      m.set(o.ship_date, (m.get(o.ship_date) ?? 0) + Math.max(0, o.qty - o.shipped));
    }
    return m;
  }, [rows]);

  const canDragWindow = (o: CustomerOrder) => canEdit && (production || ["draft", "returned", "submitted"].includes(o.status));
  const canDragDates = (o: CustomerOrder) => production && o.status === "accepted" && o.stage !== "shipped";
  const shift = (d: string | null, days_: number) => (d ? dayjs(d).add(days_, "day").format("YYYY-MM-DD") : null);
  const onDrop = (o: CustomerOrder, day: string) => {
    const g = drag.current;
    drag.current = null;
    setDropDay(null);
    if (!g || g.id !== o.id || g.from === day) return;
    const delta = dayjs(day).diff(dayjs(g.from), "day");
    if (g.kind === "window") setMoving({ order: o, preset: { ship_from: shift(o.ship_from, delta), ship_to: shift(o.ship_to, delta) } });
    else if (g.kind === "ready") setMoving({ order: o, preset: { ready_date: day } });
    else {
      // отгрузку двигаем вместе с готовностью — промежуток между ними сохраняется
      setMoving({ order: o, preset: { ship_date: day, ready_date: shift(o.promised_ready, delta) } });
    }
  };

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
    work: token.colorInfo,
    ready: token.colorSuccess,
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
          <Input.Search allowClear placeholder="Счёт, клиент, позиция, менеджер" style={{ width: 300 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Button
            disabled={!rows.length}
            onClick={() =>
              exportToExcel(
                `График отгрузок ${start.format("DD.MM")}-${end.format("DD.MM.YYYY")}`,
                rows.map((o) => {
                  const f = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "");
                  return {
                    invoice: o.invoice_no, customer: o.customer ?? "", manager: o.manager_name ?? "", state: o.stage_label,
                    priority: PRIORITY_LABEL[o.priority ?? 0], window: o.ship_from || o.ship_to ? `${f(o.ship_from)} — ${f(o.ship_to)}` : "",
                    ready: f(o.promised_ready), ship: f(o.ship_date), plan: f(o.plan_finish), qty: o.qty, received: o.received, shipped: o.shipped,
                  };
                }),
                [
                  { key: "invoice", header: "Счёт" }, { key: "customer", header: "Клиент" }, { key: "manager", header: "Менеджер" },
                  { key: "state", header: "Стадия" }, { key: "priority", header: "Приоритет" }, { key: "window", header: "Вилка" },
                  { key: "ready", header: "Готовность" }, { key: "ship", header: "Отгрузка" }, { key: "plan", header: "По плану" },
                  { key: "qty", header: "Шт" }, { key: "received", header: "На складе ГП" }, { key: "shipped", header: "Отгружено" },
                ],
              )
            }
          >
            Excel
          </Button>
          <Button onClick={() => window.print()}>Печать</Button>
          {canEdit && (
            <Button type="primary" onClick={() => navigate("/customer-orders")}>
              Заказы клиентов →
            </Button>
          )}
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
        {canEdit && (
          <Typography.Text type="secondary" style={{ display: "block", marginTop: 6, fontSize: 12 }}>
            {production
              ? "Перетащите блок отгрузки или ◆ готовности на другой день — откроется перенос (у принятых — с причиной). Вилку можно сдвинуть, потянув за полосу."
              : "Вилку заказа, который ещё не принят, можно сдвинуть, потянув за полосу. Даты принятого заказа двигает производство."}
          </Typography.Text>
        )}
      </Card>

      {ordersQuery.isLoading ? (
        <Spin />
      ) : rows.length === 0 ? (
        <Empty description="В этом периоде отгрузок и заказов нет" />
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadius, background: token.colorBgContainer }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, zIndex: 2, background: token.colorBgContainer, minWidth: LEFT_W, textAlign: "left", padding: "4px 8px" }}>
                  Заказ клиента
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
                const from = o.ship_from ?? o.ship_to;
                const accepted = o.status === "accepted";
                return (
                  <tr key={o.id} style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, cursor: "pointer" }} onClick={() => navigate(`/customer-orders/${o.id}`)}>
                    <td style={{ position: "sticky", left: 0, zIndex: 1, background: token.colorBgContainer, padding: "4px 8px", maxWidth: LEFT_W }}>
                      <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {o.priority > 0 && (
                          <Tag color={PRIORITY_COLOR[o.priority]} style={{ fontSize: 11, lineHeight: "16px", marginInlineEnd: 4 }}>
                            {PRIORITY_LABEL[o.priority]}
                          </Tag>
                        )}
                        <b>{o.invoice_no}</b>
                        {o.customer ? ` · ${o.customer}` : ""}
                      </div>
                      <Space size={4} wrap>
                        <Tag color={STATE_COLOR[s]} style={{ fontSize: 11, lineHeight: "16px", marginInlineEnd: 0 }}>
                          {o.stage_label}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {accepted ? `${o.received}/${o.qty} шт` : `${o.qty} шт`}
                          {o.shipped > 0 ? ` · отгружено ${o.shipped}` : ""}
                          {o.manager_name ? ` · ${o.manager_name}` : ""}
                        </Typography.Text>
                      </Space>
                    </td>
                    {days.map((d) => {
                      const key = d.format("YYYY-MM-DD");
                      const inWindow = !!from && !!o.ship_to && key >= from && key <= o.ship_to;
                      const isShip = accepted && o.ship_date === key;
                      const isPlan = o.plan_finish === key;
                      const isReady = accepted && o.promised_ready === key;
                      const target = dropDay === `${o.id}:${key}`;
                      const tip = [
                        inWindow ? `вилка ${dayjs(from).format("DD.MM")}–${dayjs(o.ship_to).format("DD.MM")}` : null,
                        isShip ? `отгрузка ${dayjs(key).format("DD.MM")}: ${o.qty} шт` : null,
                        isPlan ? `готово по плану ${dayjs(key).format("DD.MM")}` : null,
                        isReady ? `обещанная готовность ${dayjs(key).format("DD.MM")}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      const startDrag = (kind: Drag["kind"]) => (e: React.DragEvent) => {
                        e.stopPropagation();
                        e.dataTransfer.effectAllowed = "move";
                        drag.current = { id: o.id, kind, from: key };
                      };
                      const cell = (
                        <td
                          key={key}
                          draggable={inWindow && !isShip && !isReady && canDragWindow(o)}
                          onDragStart={startDrag("window")}
                          onDragOver={(e) => {
                            if (drag.current?.id !== o.id) return;
                            e.preventDefault();
                            if (dropDay !== `${o.id}:${key}`) setDropDay(`${o.id}:${key}`);
                          }}
                          onDragEnd={() => {
                            drag.current = null;
                            setDropDay(null);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            onDrop(o, key);
                          }}
                          style={{
                            ...cellBase(d),
                            background: target ? token.colorPrimaryBgHover : inWindow ? token.colorInfoBg : cellBase(d).background,
                            borderTop: inWindow ? `1px dashed ${token.colorInfoBorder}` : undefined,
                            borderBottom: inWindow ? `1px dashed ${token.colorInfoBorder}` : undefined,
                            cursor: inWindow && canDragWindow(o) ? "grab" : undefined,
                          }}
                        >
                          {isShip && (
                            <div
                              draggable={canDragDates(o)}
                              onDragStart={startDrag("ship")}
                              style={{ position: "absolute", inset: "8px 3px", borderRadius: 3, background: stateBg[s], cursor: canDragDates(o) ? "grab" : undefined }}
                            />
                          )}
                          {isReady && (
                            <div
                              draggable={canDragDates(o)}
                              onDragStart={startDrag("ready")}
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                right: 0,
                                textAlign: "center",
                                fontSize: 10,
                                lineHeight: "11px",
                                color: token.colorText,
                                cursor: canDragDates(o) ? "grab" : undefined,
                                zIndex: 1,
                              }}
                            >
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
      {moving && <MoveDatesModal order={moving.order} preset={moving.preset} onClose={() => setMoving(null)} />}
    </Space>
  );
}
