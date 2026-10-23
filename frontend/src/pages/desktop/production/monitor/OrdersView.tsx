import { useMemo, useState } from "react";
import { Button, Popover, Space, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { Link } from "react-router-dom";
import type { MonitorArea, MonitorOrder, MonitorRow } from "../../../../api/productionMonitor";
import GroupedTable, { type GroupColumn } from "../../../../components/GroupedTable";
import QuickReport from "./QuickReport";
import { computeFlow, FlowStrip, opIncludes } from "./flow";

const r2 = (v: number) => Math.round(v * 100) / 100;
const dm = (s: string | null | undefined) => (s ? dayjs(s).format("DD.MM") : "");

/** Строка заказа (дверь) с её операциями — как строка листа «График». */
export interface LineRec {
  key: string;
  order_id: number;
  order_name: string;
  ship: string | null;
  launch: string | null;
  invoice: string;
  series: string;
  size: string;
  color: string;
  source: string;
  qty: number;
  ops: Record<string, MonitorRow[]>;
  pf: { plan: number; done: number };
  left: number; // осталось по последней операции (упаковать)
  film: MonitorRow[]; // строки с плёнкой под эту дверь (окутка/ламинация панелей) — выдана ли
}

export function buildLines(rows: MonitorRow[], orders: MonitorOrder[], areas: MonitorArea[]) {
  const orderBy = new Map(orders.map((o) => [o.id, o]));
  const areaSort = new Map(areas.map((a) => [a.code, a.sort]));
  const lines = new Map<string, LineRec>();
  const opSeq = new Map<string, number>();
  const pfOf = new Map<string, { plan: number; done: number }>();
  const filmOf = new Map<string, MonitorRow[]>();
  for (const r of rows) {
    if (r.order_id == null || r.order_line_id == null) continue;
    const key = `${r.order_id}|${r.order_line_id}`;
    if (r.film_status) (filmOf.get(key) ?? filmOf.set(key, []).get(key)!).push(r);
    if (r.part_id != null) {
      // п/ф под эту дверь — одной сводкой (подробно — в «Заданиях цехов»)
      const p = pfOf.get(key) ?? { plan: 0, done: 0 };
      p.plan += r.plan;
      p.done += r.closed ? r.plan : Math.min(r.good, r.plan);
      pfOf.set(key, p);
      continue;
    }
    const op = r.operation ?? r.area;
    // порядок столбцов: этап маршрута, при равных — участок по срокам плана (раньше начинается — левее)
    const seq = (r.op_seq ?? 1000) * 1000 + (areaSort.get(r.area) ?? 999);
    opSeq.set(op, Math.min(opSeq.get(op) ?? seq, seq));
    let l = lines.get(key);
    if (!l) {
      const o = orderBy.get(r.order_id);
      l = {
        key, order_id: r.order_id, order_name: o ? `№${o.id} «${o.name}»` : `№${r.order_id}`, ship: o?.ship_date ?? null,
        launch: r.launch_date ?? null, invoice: r.invoice_no ?? "", series: r.series ?? "", size: r.size ?? "", color: r.color ?? "",
        source: r.source || r.position, qty: r.line_qty ?? r.plan, ops: {}, pf: { plan: 0, done: 0 }, left: 0, film: [],
      };
      lines.set(key, l);
    }
    (l.ops[op] ??= []).push(r);
  }
  const ops = [...opSeq.entries()].sort((a, b) => a[1] - b[1]).map(([op]) => op);
  const last = ops[ops.length - 1];
  for (const l of lines.values()) {
    l.pf = pfOf.get(l.key) ?? { plan: 0, done: 0 };
    l.film = filmOf.get(l.key) ?? [];
    const rs = (last && l.ops[last]) || [];
    l.left = rs.length ? rs.reduce((s, r) => s + (r.closed ? 0 : Math.max(0, r.plan - r.good)), 0) : l.qty;
  }
  return { lines: [...lines.values()], ops };
}

// выдача плёнки под строки, что ещё в работе (как на доске выдачи, 16.10)
const FILM_OK = new Set(["issued", "covered", "site_stock"]);
function FilmCell({ rs }: { rs: MonitorRow[] }) {
  const open = rs.filter((r) => !r.closed && r.plan - r.good > 0);
  if (!open.length) return rs.length ? <Typography.Text type="secondary">—</Typography.Text> : null;
  const ok = open.filter((r) => FILM_OK.has(r.film_status ?? "")).length;
  const partial = open.filter((r) => r.film_status === "partial").length;
  const toIssue = open.reduce((s, r) => s + (FILM_OK.has(r.film_status ?? "") ? 0 : r.film_to_issue_m ?? 0), 0);
  const [color, text] = ok === open.length ? ["green", "выдана"] : ok === 0 && partial === 0 ? ["red", "не выдана"] : ["orange", `${ok} из ${open.length}`];
  return (
    <Tooltip title={`строк с плёнкой в работе: ${open.length}; выдано: ${ok}${toIssue > 0 ? `; ещё выдать ${r2(toIssue)} м` : ""}`}>
      <Tag color={color} style={{ marginInlineEnd: 0 }}>
        {text}
      </Tag>
    </Tooltip>
  );
}

const sumOp = (rs: MonitorRow[] = []) => ({
  plan: rs.reduce((s, r) => s + r.plan, 0),
  done: rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0),
  defect: rs.reduce((s, r) => s + r.defect, 0),
});

function OpCell({ rs, ready, onOpenTask }: { rs: MonitorRow[] | undefined; ready?: number; onOpenTask: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  if (!rs?.length) return <Typography.Text type="secondary">—</Typography.Text>;
  const s = sumOp(rs);
  const full = s.done >= s.plan - 1e-9;
  const text = (
    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500, color: full ? "#389e0d" : s.done > 0 ? "#C97A2B" : undefined }}>
      {r2(s.done)}
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        /{r2(s.plan)}
      </Typography.Text>
      {s.defect > 0 && <Typography.Text type="danger" style={{ fontSize: 11 }}> б{r2(s.defect)}</Typography.Text>}
      {/* поток (23.10): сделано здесь, следующий этап ещё не сделал */}
      {(ready ?? 0) > 0 && (
        <span style={{ display: "block", fontSize: 10, fontWeight: 400, color: "#389e0d", lineHeight: 1 }}>ждёт {r2(ready!)}</span>
      )}
    </span>
  );
  const quick = rs.filter((r) => r.quick);
  if (!quick.length)
    return (
      <Tooltip title="Отчёт — в задании участка (нужен рулон или дневной план)">
        <Button type="text" size="small" style={{ padding: "0 4px" }} onClick={() => onOpenTask(rs[0].task_id)}>
          {text}
        </Button>
      </Tooltip>
    );
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      title="Отчёт"
      content={
        <Space direction="vertical">
          {quick.map((r) => (
            <QuickReport key={r.task_line_id} row={r} onDone={() => setOpen(false)} />
          ))}
          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => onOpenTask(rs[0].task_id)}>
            открыть задание №{rs[0].task_id}
          </Button>
        </Space>
      }
    >
      <Button type="text" size="small" style={{ padding: "0 4px" }} aria-label="Внести отчёт">
        {text}
      </Button>
    </Popover>
  );
}

/** «Заказы на производство» (21.10): как лист «График» — строка на позицию
 * заказа, столбец на операцию маршрута (сделано/план, клик — отчёт), «осталось
 * упаковать», п/ф под дверь сводкой. Группировка: заказ → счёт. */
export default function OrdersView({
  rows,
  orders,
  areas,
  hideDone,
  onOpenTask,
}: {
  rows: MonitorRow[];
  orders: MonitorOrder[];
  areas: MonitorArea[];
  hideDone: boolean;
  onOpenTask: (id: number) => void;
}) {
  const { lines, ops } = useMemo(() => buildLines(rows, orders, areas), [rows, orders, areas]);
  // поток по этапам (23.10): готово к передаче / в работе, итого
  const flow = useMemo(() => computeFlow(lines, ops), [lines, ops]);
  const [stage, setStage] = useState<string | null>(null);
  const stageOn = stage && ops.includes(stage) ? stage : null;
  const data = useMemo(
    () =>
      lines.filter((l) => {
        if (hideDone && !(l.left > 0)) return false;
        if (!stageOn) return true;
        const f = flow.byLine.get(l.key)?.[stageOn];
        return !!f && (f.ready > 0 || f.inWork > 0);
      }),
    [lines, hideDone, stageOn, flow],
  );
  const columns: GroupColumn<LineRec>[] = [
    { key: "invoice", title: "Счёт", width: 140, fixed: "left", sortValue: (l) => l.invoice, render: (_, l) => <span style={{ whiteSpace: "nowrap" }}>{l.invoice}</span> },
    { key: "series", title: "Серия", width: 80, sortValue: (l) => l.series, render: (_, l) => l.series },
    { key: "size", title: "Размер", width: 90, sortValue: (l) => l.size, render: (_, l) => l.size },
    { key: "color", title: "Цвет", width: 150, sortValue: (l) => l.color, render: (_, l) => l.color },
    {
      key: "name",
      title: "Наименование",
      width: 240,
      ellipsis: true,
      sortValue: (l) => l.source,
      render: (_, l) => (
        <Tooltip title={l.source}>
          <span>{l.source}</span>
        </Tooltip>
      ),
    },
    {
      key: "qty",
      title: "Кол-во",
      width: 76,
      align: "right",
      sortValue: (l) => l.qty,
      render: (_, l) => <b>{r2(l.qty)}</b>,
      groupRender: (rs) => <b>{r2(rs.reduce((s, l) => s + l.qty, 0))}</b>,
    },
    {
      key: "left",
      title: "Осталось",
      width: 96,
      align: "right",
      sortValue: (l) => l.left,
      render: (_, l) => (l.left > 0 ? <b>{r2(l.left)}</b> : <Tag color="green">готово</Tag>),
      groupRender: (rs) => <b>{r2(rs.reduce((s, l) => s + l.left, 0))}</b>,
    },
    {
      key: "pf",
      title: "П/ф",
      width: 70,
      align: "right",
      render: (_, l) =>
        l.pf.plan ? (
          <Tooltip title={`детали под дверь: сделано ${r2(l.pf.done)} из ${r2(l.pf.plan)}`}>
            <Typography.Text type={l.pf.done >= l.pf.plan ? "success" : undefined}>{Math.round((l.pf.done / l.pf.plan) * 100)}%</Typography.Text>
          </Tooltip>
        ) : (
          ""
        ),
    },
    ...(lines.some((l) => l.film.length)
      ? [{ key: "film", title: "Плёнка", width: 96, align: "center" as const, render: (_: unknown, l: LineRec) => <FilmCell rs={l.film} /> }]
      : []),
    ...ops.map(
      (op): GroupColumn<LineRec> => ({
        key: `op:${op}`,
        title: (
          <span style={{ whiteSpace: "normal", fontSize: 12 }}>
            {op}
            {opIncludes(op) && (
              <Tooltip title={`Включает: ${opIncludes(op)}`}>
                <span style={{ display: "block", fontSize: 10, fontWeight: 400, opacity: 0.65 }}>вкл.: {opIncludes(op)}</span>
              </Tooltip>
            )}
          </span>
        ),
        width: 96,
        align: "center",
        sortValue: (l) => {
          const s = sumOp(l.ops[op]);
          return s.plan ? s.done / s.plan : -1;
        },
        render: (_, l) => <OpCell rs={l.ops[op]} ready={flow.byLine.get(l.key)?.[op]?.ready} onOpenTask={onOpenTask} />,
        groupRender: (ls) => {
          const s = sumOp(ls.flatMap((l) => l.ops[op] ?? []));
          return s.plan ? (
            <span style={{ fontVariantNumeric: "tabular-nums", color: s.done >= s.plan ? "#389e0d" : undefined }}>
              {r2(s.done)}/{r2(s.plan)}
            </span>
          ) : null;
        },
      }),
    ),
  ];
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
    <FlowStrip flow={flow} active={stageOn} onPick={setStage} />
    {stageOn && (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Показаны позиции, которые стоят на этапе «{stageOn}» (готово к передаче или в работе) —{" "}
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setStage(null)}>
          показать все
        </Button>
      </Typography.Text>
    )}
    <GroupedTable<LineRec>
      storageKey="monitor.orders"
      dims={[
        { key: "order", label: "Заказ", value: (l) => l.order_name + (l.ship ? ` · отгрузка ${dm(l.ship)}` : "") },
        { key: "invoice", label: "Счёт", value: (l) => l.invoice },
        { key: "launch", label: "Запуск", value: (l) => dm(l.launch) },
        { key: "series", label: "Серия", value: (l) => l.series },
        { key: "color", label: "Цвет", value: (l) => l.color },
      ]}
      defaultDims={["order", "invoice"]}
      labelColumn="name"
      size="small"
      rowKey={(l) => l.key}
      dataSource={data}
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: 140 + 80 + 90 + 150 + 240 + 76 + 96 + 70 + (lines.some((l) => l.film.length) ? 96 : 0) + ops.length * 96 + 40, y: "calc(100vh - 450px)" }}
      columns={columns}
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          клик по клетке операции — отчёт; <Link to="/production-orders">заказы →</Link>
        </Typography.Text>
      }
    />
    </Space>
  );
}
