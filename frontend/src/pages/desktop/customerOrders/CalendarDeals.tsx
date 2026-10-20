import { useState, type ReactNode } from "react";
import { Button, Segmented, Space, Tag, Tooltip, Typography, theme } from "antd";
import { MinusSquareOutlined, PlusSquareOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { getCalendarDeals, type FunnelDeal } from "../../../api/customerOrders";
import { usePersistentState } from "../../../hooks/usePersistentState";
import ScheduleImportModal from "../production/ScheduleImportModal";

const DAY_W = 36; // как столбец дня календаря заказов

/** Ключ счёта как на сервере (invoice_key): «1029-ЛД(М)» = «№1029 лд». */
const LAT2CYR: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
const invKey = (s: string | null) =>
  (s ?? "")
    .toUpperCase()
    .replace(/№/g, "")
    .replace(/(\s*\([^)]*\))+\s*$/, "")
    .replace(/[\s\-–—]+/g, "")
    .replace(/[ABCEHKMOPTXY]/g, (c) => LAT2CYR[c]);

type Group = { key: string; invoice: string; deals: FunnelDeal[] };

/** Сделки Битрикса в календаре заказов (20.10): открытые сделки воронки без
 * заказа клиента — на их дату отгрузки (поле сделки или срок её дела).
 * В Битриксе на счёт — сделка на вид продукции; «Раздельно» — строка на
 * сделку, «По счетам» — строка на счёт (все даты его сделок), раскрывается
 * до сделок. Из сделки — «Создать заказ клиента»; счёт уже в заказах (другой
 * вид) — «Открыть заказ», дополнить его. Без даты — списком. */
export default function CalendarDeals({
  days,
  leftWidth,
  canCreate,
  needle,
}: {
  days: Dayjs[];
  leftWidth: number;
  canCreate: boolean;
  needle: string;
}) {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const from = days[0].format("YYYY-MM-DD");
  const to = days[days.length - 1].format("YYYY-MM-DD");
  const q = useQuery({ queryKey: ["calendar-deals", from, to], queryFn: () => getCalendarDeals(from, to), staleTime: 60_000 });
  const [open, setOpen] = usePersistentState("calendar.deals.open", false);
  const [mode, setMode] = usePersistentState<"split" | "invoice">("calendar.deals.mode", "invoice");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showUndated, setShowUndated] = useState(false);
  const [creating, setCreating] = useState<FunnelDeal | null>(null);
  if (!q.data?.connected) return null;
  const hit = (d: FunnelDeal) => !needle || [d.title, d.company, d.assigned].some((v) => (v ?? "").toLowerCase().includes(needle));
  const dated = q.data.dated.filter(hit).sort((a, b) => (a.ship_date ?? "").localeCompare(b.ship_date ?? ""));
  const undated = q.data.undated.filter(hit);
  if (!dated.length && !undated.length) return null;

  const group = (list: FunnelDeal[]): Group[] => {
    const m = new Map<string, Group>();
    for (const d of list) {
      const k = d.invoice ? invKey(d.invoice) : `#${d.id}`;
      const g = m.get(k) ?? { key: k, invoice: d.invoice ?? d.title, deals: [] };
      g.deals.push(d);
      m.set(k, g);
    }
    return [...m.values()];
  };
  const toggle = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const action = (d: FunnelDeal) =>
    d.order_id ? (
      <Button size="small" type="link" style={{ padding: 0 }} onClick={() => navigate(`/customer-orders/${d.order_id}`)}>
        Счёт уже в заказах — открыть заказ №{d.order_id}
      </Button>
    ) : canCreate ? (
      <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setCreating(d)}>
        Создать заказ клиента
      </Button>
    ) : null;
  const dealHead = (d: FunnelDeal, indent = false) => (
    <div style={{ display: "grid", gap: 2, paddingLeft: indent ? 18 : 0 }}>
      <Space size={4} wrap>
        {d.url ? (
          <a href={d.url} target="_blank" rel="noreferrer">
            <b>{d.title}</b>
          </a>
        ) : (
          <b>{d.title}</b>
        )}
        <Tag style={{ marginInlineEnd: 0 }}>{d.stage_name}</Tag>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {[d.company, d.assigned, d.amount ? `${Math.round(d.amount).toLocaleString("ru-RU")} ₽` : null].filter(Boolean).join(" · ")}
      </Typography.Text>
      {action(d)}
    </div>
  );
  const groupHead = (g: Group) => {
    const isOpen = expanded.has(g.key);
    const order = g.deals.find((d) => d.order_id)?.order_id;
    return (
      <div style={{ display: "grid", gap: 2 }}>
        <Space size={4} wrap>
          {g.deals.length > 1 && (
          <Button
            type="text"
            size="small"
            icon={isOpen ? <MinusSquareOutlined /> : <PlusSquareOutlined />}
            aria-expanded={isOpen}
            aria-label={isOpen ? "Свернуть сделки счёта" : "Раскрыть сделки счёта"}
            onClick={() => toggle(g.key)}
          />
          )}
          <b>Счёт {g.invoice}</b>
          <Tag style={{ marginInlineEnd: 0 }}>сделок {g.deals.length}</Tag>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {[...new Set(g.deals.map((d) => d.company).filter(Boolean))].join(", ")}
        </Typography.Text>
        {!isOpen && g.deals.length === 1 && action(g.deals[0])}
        {!isOpen && g.deals.length > 1 && order && action(g.deals.find((d) => d.order_id)!)}
      </div>
    );
  };
  const marks = (list: FunnelDeal[], day: Dayjs): ReactNode => {
    const key = day.format("YYYY-MM-DD");
    const on = list.filter((d) => d.ship_date === key);
    if (!on.length) return null;
    return (
      <Tooltip title={on.map((d) => d.title).join("\n") + ` — отгрузка ${dayjs(key).format("DD.MM.YYYY")}`}>
        <span
          style={{ display: "inline-block", minWidth: 18, height: 14, border: `2px dashed ${token.colorWarning}`, borderRadius: 3, fontSize: 10, lineHeight: "10px" }}
          aria-label={`отгрузка ${dayjs(key).format("DD.MM")}: ${on.length}`}
        >
          {on.length > 1 ? on.length : ""}
        </span>
      </Tooltip>
    );
  };
  const row = (key: string, head: ReactNode, list: FunnelDeal[], sub = false) => (
    <tr key={key} style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, background: sub ? token.colorFillQuaternary : undefined }}>
      <td style={{ position: "sticky", left: 0, zIndex: 1, background: token.colorBgContainer, minWidth: leftWidth, maxWidth: leftWidth, padding: "4px 8px", verticalAlign: "top" }}>
        {head}
      </td>
      {days.map((day) => (
        <td
          key={day.format("YYYY-MM-DD")}
          style={{
            width: DAY_W,
            minWidth: DAY_W,
            height: 30,
            padding: 0,
            textAlign: "center",
            borderLeft: `1px solid ${token.colorBorderSecondary}`,
            background: day.day() === 0 || day.day() === 6 ? token.colorFillQuaternary : undefined,
          }}
        >
          {marks(list, day)}
        </td>
      ))}
    </tr>
  );
  const rows: ReactNode[] =
    mode === "split"
      ? dated.map((d) => row(`d${d.id}`, dealHead(d), [d]))
      : group(dated).flatMap((g) => [
          row(`g${g.key}`, groupHead(g), g.deals),
          ...(expanded.has(g.key) ? g.deals.map((d) => row(`g${g.key}d${d.id}`, dealHead(d, true), [d], true)) : []),
        ]);
  const undatedGroups = group(undated);

  return (
    <div style={{ border: `1px dashed ${token.colorWarningBorder}`, borderRadius: token.borderRadius, background: token.colorBgContainer, padding: 8 }}>
      <Space wrap size={[12, 4]}>
        <Typography.Text strong>Сделки Битрикса без заказа клиента</Typography.Text>
        <Typography.Text type="secondary">
          с датой отгрузки в периоде: {dated.length} · без даты: {undated.length}
        </Typography.Text>
        <Button size="small" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Скрыть" : "Показать на календаре"}
        </Button>
        {open && (
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as "split" | "invoice")}
            options={[
              { value: "invoice", label: "По счетам" },
              { value: "split", label: "Раздельно" },
            ]}
          />
        )}
        {open && mode === "invoice" && (
          <Button
            size="small"
            type="link"
            onClick={() => setExpanded(expanded.size ? new Set() : new Set(group(dated).filter((g) => g.deals.length > 1).map((g) => g.key)))}
          >
            {expanded.size ? "свернуть все" : "раскрыть все"}
          </Button>
        )}
        {undated.length > 0 && (
          <Button size="small" onClick={() => setShowUndated(!showUndated)} aria-expanded={showUndated}>
            {showUndated ? "Скрыть без даты" : `Без даты (${undated.length})`}
          </Button>
        )}
      </Space>
      {open && dated.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, zIndex: 2, background: token.colorBgContainer, minWidth: leftWidth, textAlign: "left", padding: "2px 8px" }}>
                  {mode === "invoice" ? "Счёт" : "Сделка"}
                </th>
                {days.map((d) => (
                  <th key={d.format("YYYY-MM-DD")} style={{ width: DAY_W, minWidth: DAY_W, fontWeight: d.date() === 1 || d.day() === 1 ? 600 : 400, padding: "2px 0", textAlign: "center" }}>
                    <div style={{ color: token.colorTextTertiary }}>{["вс", "пн", "вт", "ср", "чт", "пт", "сб"][d.day()]}</div>
                    <div>{d.format(d.date() === 1 ? "D MMM" : "D")}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      )}
      {showUndated && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8, marginTop: 8 }}>
          {(mode === "invoice" ? undatedGroups : undated.map((d) => ({ key: `#${d.id}`, invoice: d.title, deals: [d] }))).map((g) => (
            <div key={g.key} style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadius, padding: 6, display: "grid", gap: 6 }}>
              {g.deals.length > 1 && <b>Счёт {g.invoice}</b>}
              {g.deals.map((d) => (
                <div key={d.id}>{dealHead(d, g.deals.length > 1)}</div>
              ))}
            </div>
          ))}
        </div>
      )}
      {creating && (
        <ScheduleImportModal
          target="customer"
          fromDeal={{
            id: creating.id,
            title: creating.title,
            invoice: creating.invoice,
            company: creating.company,
            amount: creating.amount,
            assignedBx: creating.assigned_bx,
            shipDate: creating.ship_date ?? null,
          }}
          onClose={() => setCreating(null)}
          onCustomerCreated={(ids) => {
            setCreating(null);
            qc.invalidateQueries({ queryKey: ["calendar-deals"] });
            qc.invalidateQueries({ queryKey: ["order-calendar"] });
            if (ids.length === 1) navigate(`/customer-orders/${ids[0]}`);
          }}
        />
      )}
    </div>
  );
}
