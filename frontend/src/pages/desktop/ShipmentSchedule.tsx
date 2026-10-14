import { useMemo, useRef, useState } from "react";
import { Button, Card, DatePicker, Empty, Grid, Input, Segmented, Space, Spin, Tag, Tooltip, Typography, theme } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { getOrderCalendar, listCustomerOrders, type CalendarArea, type CalendarRow, type CustomerOrder } from "../../api/customerOrders";
import { PRIORITY_COLOR, PRIORITY_LABEL } from "../../api/productionOrders";
import { exportToExcel } from "../../utils/excel";
import { MoveDatesModal, useCustomerOrderRights } from "./customerOrders/parts";

/** Календарь заказов (09.10 график отгрузок; 14.10 — план и факт по дням).
 * На строке — вилка клиента (светлая полоса), обещанная отгрузка (блок,
 * цвет — состояние), обещанная готовность (◆), «готово по плану» (▲) и
 * полоска производства дня внизу: прошедший день — сделано ли запланированное
 * (зелёная — всё, жёлтая — часть, красная — ничего), будущий — есть план.
 * Строка раскрывается по участкам: в клетке — факт за день (прошедшие) или
 * план (будущие), в подсказке — оба. Заказы на производство без заказа
 * клиента (окутка, погонаж по счёту) — тоже здесь, без перетаскивания.
 *
 * Перетаскивание: менеджер двигает вилку, пока заказ не принят;
 * производство — отгрузку и готовность (после приёма — с причиной, окно
 * переноса откроется само). */

type State = "shipped" | "late" | "work" | "ready" | "accepted" | "submitted" | "returned" | "draft" | "closed";

const STATE_LABEL: Record<State, string> = {
  shipped: "отгружен",
  late: "не успевает",
  work: "в производстве",
  ready: "готов / отгружается",
  accepted: "принят, не запущен",
  submitted: "ждёт решения",
  returned: "возвращён",
  draft: "черновик",
  closed: "завершён",
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
  closed: "default",
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
  ["shipped", "Отгруженные", (s) => s === "shipped" || s === "closed"],
];

/** Строка календаря: заказ клиента или заказ на производство без заказов клиентов. */
type Row = {
  key: string;
  co: CustomerOrder | null;
  cal: CalendarRow | null;
  state: State;
  title: string;
  sub: string;
  ship_date: string | null;
  promised_ready: string | null;
  plan_finish: string | null;
  plan_late: boolean;
  ship_from: string | null;
  ship_to: string | null;
};

function poState(c: CalendarRow): State {
  if (!c.released) return "closed";
  const promised = c.promised_ready ?? c.ship_date;
  return c.plan_finish && promised && c.plan_finish > promised ? "late" : "work";
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** День заказа по всем участкам: [план, факт]. */
function daySum(areas: CalendarArea[] | undefined, key: string): [number, number] {
  let p = 0;
  let f = 0;
  for (const a of areas ?? []) {
    const c = a.days[key];
    if (c) {
      p += c[0];
      f += c[1];
    }
  }
  return [p, f];
}

const DAY_W = 36;
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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  const drag = useRef<Drag | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ order: CustomerOrder; preset: Parameters<typeof MoveDatesModal>[0]["preset"] } | null>(null);

  const days = useMemo(() => Array.from({ length: weeks * 7 }, (_, i) => start.add(i, "day")), [start, weeks]);
  const end = days[days.length - 1];
  const calQuery = useQuery({
    queryKey: ["order-calendar", start.format("YYYY-MM-DD"), end.format("YYYY-MM-DD")],
    queryFn: () => getOrderCalendar(start.format("YYYY-MM-DD"), end.format("YYYY-MM-DD")),
  });
  const calByKey = useMemo(() => new Map((calQuery.data ?? []).map((c) => [c.key, c])), [calQuery.data]);
  const today = dayjs().format("YYYY-MM-DD");
  const needle = q.trim().toLowerCase();

  const rows = useMemo(() => {
    const inRange = (d: string | null | undefined) => !!d && !dayjs(d).isBefore(start, "day") && !dayjs(d).isAfter(end, "day");
    const busy = (c: CalendarRow | null | undefined) => !!c && c.areas.some((a) => Object.keys(a.days).length > 0);
    const coRows: Row[] = (ordersQuery.data ?? [])
      .filter((o) => o.status !== "cancelled")
      .filter((o) => {
        const from = o.ship_from ?? o.ship_to;
        const windowHits = !!from && !!o.ship_to && !dayjs(o.ship_to).isBefore(start, "day") && !dayjs(from).isAfter(end, "day");
        return inRange(o.ship_date) || windowHits || inRange(o.plan_finish) || inRange(o.promised_ready) || busy(calByKey.get(`co:${o.id}`));
      })
      .filter(
        (o) =>
          !needle ||
          `${o.invoice_no} ${o.customer ?? ""} ${o.lines.map((l) => l.item_name).join(" ")} ${o.manager_name ?? ""}`.toLowerCase().includes(needle),
      )
      .map((o) => ({
        key: `co:${o.id}`,
        co: o,
        cal: calByKey.get(`co:${o.id}`) ?? null,
        state: stateOf(o),
        title: o.invoice_no,
        sub: o.customer ?? "",
        ship_date: o.ship_date,
        promised_ready: o.promised_ready,
        plan_finish: o.plan_finish,
        plan_late: !!o.plan_late,
        ship_from: o.ship_from,
        ship_to: o.ship_to,
      }));
    const poRows: Row[] = (calQuery.data ?? [])
      .filter((c) => c.kind === "po")
      .filter((c) => busy(c) || inRange(c.ship_date) || inRange(c.promised_ready) || inRange(c.plan_finish))
      .filter((c) => !needle || `${c.title} ${c.customer ?? ""}`.toLowerCase().includes(needle))
      .map((c) => ({
        key: c.key,
        co: null,
        cal: c,
        state: poState(c),
        title: c.title,
        sub: c.customer ?? "заказ на производство",
        ship_date: c.ship_date,
        promised_ready: c.promised_ready,
        plan_finish: c.plan_finish,
        plan_late: poState(c) === "late",
        ship_from: null,
        ship_to: null,
      }));
    const first = (r: Row) => {
      const ds = (r.cal?.areas ?? []).flatMap((a) => Object.keys(a.days)).sort();
      return r.ship_date ?? r.ship_from ?? r.ship_to ?? ds[0] ?? r.plan_finish ?? "";
    };
    return [...coRows, ...poRows]
      .filter((r) => FILTERS.find((f) => f[0] === filter)![2](r.state))
      .sort((a, b) => first(a).localeCompare(first(b)));
  }, [ordersQuery.data, calQuery.data, calByKey, start, end, filter, needle]);

  // Сколько дверей уходит в день — по обещанным отгрузкам принятых заказов.
  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const o = r.co;
      if (!o || !o.ship_date || o.status !== "accepted" || o.stage === "shipped") continue;
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
    closed: token.colorTextQuaternary,
  };
  // полоска/клетка производства дня: прошедший — по факту против плана, будущий — план
  const dayTone = (key: string, plan: number, fact: number): string | undefined => {
    if (plan <= 0 && fact <= 0) return undefined;
    if (key > today) return token.colorBorder;
    if (plan <= 0 || fact >= plan - 1e-6) return token.colorSuccess;
    if (fact > 0) return token.colorWarning;
    return key === today ? token.colorBorder : token.colorError;
  };
  const isOpen = (k: string) => allOpen || open.has(k);
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small" title="Календарь заказов">
        <Space wrap size={[12, 8]}>
          <Space size={4}>
            <Button onClick={() => setStart(start.subtract(1, "week"))}>←</Button>
            <DatePicker picker="week" value={start} onChange={(v) => v && setStart(v.startOf("week"))} format="[с] DD.MM.YYYY" allowClear={false} />
            <Button onClick={() => setStart(start.add(1, "week"))}>→</Button>
            <Button onClick={() => setStart(dayjs().startOf("week").subtract(1, "week"))}>Сегодня</Button>
          </Space>
          <Segmented value={weeks} onChange={(v) => setWeeks(v as number)} options={[{ value: 4, label: "4 нед." }, { value: 6, label: "6 нед." }, { value: 10, label: "10 нед." }]} />
          <Segmented value={filter} onChange={(v) => setFilter(v as Filter)} options={FILTERS.map(([value, label]) => ({ value, label }))} />
          <Button onClick={() => (allOpen ? (setAllOpen(false), setOpen(new Set())) : setAllOpen(true))}>
            {allOpen ? "Свернуть участки" : "Раскрыть по участкам"}
          </Button>
          <Input.Search allowClear placeholder="Счёт, клиент, позиция, менеджер" style={{ width: 300 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Button
            disabled={!rows.length}
            onClick={() =>
              exportToExcel(
                `График отгрузок ${start.format("DD.MM")}-${end.format("DD.MM.YYYY")}`,
                rows.map((r) => {
                  const f = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "");
                  const o = r.co;
                  return {
                    invoice: r.title, customer: r.co ? r.co.customer ?? "" : r.sub, manager: o?.manager_name ?? "", state: o ? o.stage_label : STATE_LABEL[r.state],
                    priority: o ? PRIORITY_LABEL[o.priority ?? 0] : "", window: r.ship_from || r.ship_to ? `${f(r.ship_from)} — ${f(r.ship_to)}` : "",
                    ready: f(r.promised_ready), ship: f(r.ship_date), plan: f(r.plan_finish), qty: o?.qty ?? "", received: o?.received ?? "", shipped: o?.shipped ?? "",
                    progress: (r.cal?.areas ?? []).map((a) => `${a.area_name} ${r1(a.done)}/${r1(a.need)}`).join("; "),
                  };
                }),
                [
                  { key: "invoice", header: "Счёт" }, { key: "customer", header: "Клиент" }, { key: "manager", header: "Менеджер" },
                  { key: "state", header: "Стадия" }, { key: "priority", header: "Приоритет" }, { key: "window", header: "Вилка" },
                  { key: "ready", header: "Готовность" }, { key: "ship", header: "Отгрузка" }, { key: "plan", header: "По плану" },
                  { key: "qty", header: "Шт" }, { key: "received", header: "На складе ГП" }, { key: "shipped", header: "Отгружено" },
                  { key: "progress", header: "Сделано по участкам" },
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
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <span style={{ display: "inline-block", width: 18, height: 4, background: token.colorSuccess, marginRight: 4, verticalAlign: "middle" }} />
            день сделан по плану,
            <span style={{ display: "inline-block", width: 18, height: 4, background: token.colorWarning, margin: "0 4px", verticalAlign: "middle" }} />
            частично,
            <span style={{ display: "inline-block", width: 18, height: 4, background: token.colorError, margin: "0 4px", verticalAlign: "middle" }} />
            не сделан,
            <span style={{ display: "inline-block", width: 18, height: 4, background: token.colorBorder, margin: "0 4px", verticalAlign: "middle" }} />
            план
          </Typography.Text>
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

      {ordersQuery.isLoading || calQuery.isLoading ? (
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
              {rows.flatMap((r) => {
                const s = r.state;
                const o = r.co;
                const from = r.ship_from ?? r.ship_to;
                const accepted = o ? o.status === "accepted" : true;
                const areas = r.cal?.areas ?? [];
                const expanded = isOpen(r.key) && areas.length > 0;
                const go = () => navigate(o ? `/customer-orders/${o.id}` : `/production-orders?order=${r.cal!.id}`);
                const main = (
                  <tr key={r.key} style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, cursor: "pointer" }} onClick={go}>
                    <td style={{ position: "sticky", left: 0, zIndex: 1, background: token.colorBgContainer, padding: "4px 8px", maxWidth: LEFT_W }}>
                      <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {areas.length > 0 && (
                          <Button
                            size="small"
                            type="text"
                            style={{ padding: "0 4px", height: 18, marginRight: 2 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (allOpen) {
                                setAllOpen(false);
                                setOpen(new Set(rows.filter((x) => x.key !== r.key).map((x) => x.key)));
                              } else toggle(r.key);
                            }}
                            aria-label={expanded ? "Свернуть участки" : "Раскрыть по участкам"}
                          >
                            {expanded ? "▾" : "▸"}
                          </Button>
                        )}
                        {o && o.priority > 0 && (
                          <Tag color={PRIORITY_COLOR[o.priority]} style={{ fontSize: 11, lineHeight: "16px", marginInlineEnd: 4 }}>
                            {PRIORITY_LABEL[o.priority]}
                          </Tag>
                        )}
                        <b>{r.title}</b>
                        {r.sub ? ` · ${r.sub}` : ""}
                      </div>
                      <Space size={4} wrap>
                        <Tag color={STATE_COLOR[s]} style={{ fontSize: 11, lineHeight: "16px", marginInlineEnd: 0 }}>
                          {o ? o.stage_label : STATE_LABEL[s]}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {o ? (accepted ? `${o.received}/${o.qty} шт` : `${o.qty} шт`) : ""}
                          {o && o.shipped > 0 ? ` · отгружено ${o.shipped}` : ""}
                          {o?.manager_name ? ` · ${o.manager_name}` : ""}
                          {!o && areas.length
                            ? `сделано ${Math.round((100 * areas.reduce((x, a) => x + Math.min(a.done, a.need), 0)) / Math.max(1, areas.reduce((x, a) => x + a.need, 0)))}%`
                            : ""}
                        </Typography.Text>
                      </Space>
                    </td>
                    {days.map((d) => {
                      const key = d.format("YYYY-MM-DD");
                      const inWindow = !!from && !!r.ship_to && key >= from && key <= r.ship_to;
                      const isShip = accepted && r.ship_date === key;
                      const isPlan = r.plan_finish === key;
                      const isReady = accepted && r.promised_ready === key;
                      const [dp, df] = daySum(areas, key);
                      const tone = dayTone(key, dp, df);
                      const target = !!o && dropDay === `${o.id}:${key}`;
                      const tip = [
                        inWindow ? `вилка ${dayjs(from).format("DD.MM")}–${dayjs(r.ship_to).format("DD.MM")}` : null,
                        isShip ? `отгрузка ${dayjs(key).format("DD.MM")}${o ? `: ${o.qty} шт` : ""}` : null,
                        isPlan ? `готово по плану ${dayjs(key).format("DD.MM")}` : null,
                        isReady ? `обещанная готовность ${dayjs(key).format("DD.MM")}` : null,
                        tone
                          ? `${dayjs(key).format("DD.MM")}: план ${r1(dp)}, сделано ${r1(df)} (все участки; раскройте строку — по участкам)`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      const startDrag = (kind: Drag["kind"]) => (e: React.DragEvent) => {
                        e.stopPropagation();
                        if (!o) return;
                        e.dataTransfer.effectAllowed = "move";
                        drag.current = { id: o.id, kind, from: key };
                      };
                      const cell = (
                        <td
                          key={key}
                          draggable={!!o && inWindow && !isShip && !isReady && canDragWindow(o)}
                          onDragStart={startDrag("window")}
                          onDragOver={(e) => {
                            if (!o || drag.current?.id !== o.id) return;
                            e.preventDefault();
                            if (dropDay !== `${o.id}:${key}`) setDropDay(`${o.id}:${key}`);
                          }}
                          onDragEnd={() => {
                            drag.current = null;
                            setDropDay(null);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (o) onDrop(o, key);
                          }}
                          style={{
                            ...cellBase(d),
                            background: target ? token.colorPrimaryBgHover : inWindow ? token.colorInfoBg : cellBase(d).background,
                            borderTop: inWindow ? `1px dashed ${token.colorInfoBorder}` : undefined,
                            borderBottom: inWindow ? `1px dashed ${token.colorInfoBorder}` : undefined,
                            cursor: o && inWindow && canDragWindow(o) ? "grab" : undefined,
                          }}
                        >
                          {tone && (
                            <div style={{ position: "absolute", left: 2, right: 2, bottom: 0, height: 4, borderRadius: 2, background: tone }} />
                          )}
                          {isShip && (
                            <div
                              draggable={!!o && canDragDates(o)}
                              onDragStart={startDrag("ship")}
                              style={{ position: "absolute", inset: "8px 3px", borderRadius: 3, background: stateBg[s], cursor: o && canDragDates(o) ? "grab" : undefined }}
                            />
                          )}
                          {isReady && (
                            <div
                              draggable={!!o && canDragDates(o)}
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
                                cursor: o && canDragDates(o) ? "grab" : undefined,
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
                                color: r.plan_late ? token.colorError : token.colorText,
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
                if (!expanded) return [main];
                // по участкам: прошедшие дни — факт (цвет — против плана), будущие — план
                const sub = areas.map((a) => (
                  <tr key={`${r.key}|${a.area}`} style={{ background: token.colorFillQuaternary }}>
                    <td
                      style={{
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                        background: token.colorBgLayout,
                        padding: "2px 8px 2px 28px",
                        maxWidth: LEFT_W,
                        fontSize: 11,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {a.area_name}{" "}
                      <Typography.Text type={a.done >= a.need - 1e-6 ? "success" : "secondary"} style={{ fontSize: 11 }}>
                        {r1(a.done)}/{r1(a.need)}
                      </Typography.Text>
                    </td>
                    {days.map((d) => {
                      const key = d.format("YYYY-MM-DD");
                      const c = a.days[key];
                      const tone = c ? dayTone(key, c[0], c[1]) : undefined;
                      const past = key <= today;
                      const shown = c ? (past ? c[1] : c[0]) : 0;
                      const body = (
                        <td
                          key={key}
                          style={{
                            ...cellBase(d),
                            height: 22,
                            textAlign: "center",
                            fontSize: 10,
                            fontVariantNumeric: "tabular-nums",
                            color: past ? tone : token.colorTextTertiary,
                            fontWeight: past && c ? 600 : 400,
                          }}
                        >
                          {c && (shown > 0 || (past && c[0] > 0)) ? r1(shown) : ""}
                        </td>
                      );
                      return c ? (
                        <Tooltip key={key} title={`${a.area_name}, ${dayjs(key).format("DD.MM")}: план ${r1(c[0])}, сделано ${r1(c[1])}`}>
                          {body}
                        </Tooltip>
                      ) : (
                        body
                      );
                    })}
                  </tr>
                ));
                return [main, ...sub];
              })}
            </tbody>
          </table>
        </div>
      )}
      {moving && <MoveDatesModal order={moving.order} preset={moving.preset} onClose={() => setMoving(null)} />}
    </Space>
  );
}
