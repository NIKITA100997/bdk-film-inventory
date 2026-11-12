import { useMemo, useState } from "react";
import { Button, Popover, Space, Tag, Tooltip, Typography } from "antd";
import { ApartmentOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { Link } from "react-router-dom";
import type { MonitorArea, MonitorOrder, MonitorRow } from "../../../../api/productionMonitor";
import GroupedTable, { type GroupColumn } from "../../../../components/GroupedTable";
import BatchQuickReport from "./BatchQuickReport";
import OrderFlowMap from "./OrderFlowMap";
import { computeFlow, FlowStrip, opIncludes } from "./flow";

const r2 = (v: number) => Math.round(v * 100) / 100;
const dm = (s: string | null | undefined) => (s ? dayjs(s).format("DD.MM") : "");

export interface PfRec {
  plan: number;
  done: number;
  framesPlan: number;
  framesDone: number;
  panelsPlan: number;
  panelsDone: number;
  panelsLaminated?: number;
  readySets: number;
  totalSets: number;
}

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
  pf: PfRec;
  left: number; // осталось по последней операции конкретной позиции
}

export function buildLines(rows: MonitorRow[], orders: MonitorOrder[], areas: MonitorArea[]) {
  const orderBy = new Map(orders.map((o) => [o.id, o]));
  const areaSort = new Map(areas.map((a) => [a.code, a.sort]));
  const lines = new Map<string, LineRec>();
  const opSeq = new Map<string, number>();
  const pfOf = new Map<string, PfRec>();

  // Предварительно определяем, для каких позиций заказа в маршруте есть фрезеровка панелей
  const doorHasMilling = new Set<string>();
  for (const r of rows) {
    if (r.part_id != null && r.order_id != null) {
      const opLow = (r.operation || "").toLowerCase();
      if (r.area === "frezerovka_laminirovannykh_paneley" || opLow.includes("фрезер")) {
        const sOrders = r.source_orders?.length
          ? r.source_orders
          : r.order_line_id != null
          ? [{ order_line_id: r.order_line_id }]
          : [];
        for (const s of sOrders) {
          doorHasMilling.add(`${r.order_id}|${s.order_line_id}`);
        }
      }
    }
  }

  for (const r of rows) {
    if (r.order_id == null) continue;

    // Полуфабрикаты: каркасы и панели
    if (r.part_id != null) {
      const sources = r.source_orders?.length
        ? r.source_orders.map((s) => ({ order_line_id: s.order_line_id, qty: s.quantity_pieces }))
        : r.order_line_id != null
        ? [{ order_line_id: r.order_line_id, qty: r.plan }]
        : [];
      if (!sources.length) continue;

      for (const source of sources) {
        const key = `${r.order_id}|${source.order_line_id}`;
        const share = r.plan > 0 ? source.qty / r.plan : 0;
        const done = r.closed ? source.qty : Math.min(source.qty, r.good * share);

        const p = pfOf.get(key) ?? {
          plan: 0,
          done: 0,
          framesPlan: 0,
          framesDone: 0,
          panelsPlan: 0,
          panelsDone: 0,
          panelsLaminated: 0,
          readySets: 0,
          totalSets: 0,
        };

        const isFrame = /каркас/i.test(r.position);
        const isPanel = /панел|накладк|заготовк|мдф|скин/i.test(r.position);
        const opLow = (r.operation || "").toLowerCase();

        // Учитываем финальный передел детали:
        // Для каркаса: сборка каркаса (или если другой нет)
        // Для панели: если в маршруте есть фрезеровка ламинированных панелей — то фрезеровка;
        //             если нет (глухая панель, напр. Щ-12) — то ламинация!
        const isFinalFrame = isFrame && (opLow.includes("сборка") || !opLow.includes("распил"));
        const needsMilling = doorHasMilling.has(key);
        const isFinalPanel = isPanel && (
          needsMilling
            ? (r.area === "frezerovka_laminirovannykh_paneley" || opLow.includes("фрезер"))
            : (opLow.includes("ламинац") || opLow.includes("окутк") || r.area === "fabrika" || r.area === "uchastok_membranno_vakuumnykh_pressov")
        );

        if (isFrame && isFinalFrame) {
          p.framesPlan += source.qty;
          p.framesDone += done;
        } else if (isPanel) {
          if (opLow.includes("ламинац") || opLow.includes("окутк") || r.area === "fabrika" || r.area === "uchastok_membranno_vakuumnykh_pressov") {
            p.panelsLaminated = (p.panelsLaminated || 0) + done;
          }
          if (isFinalPanel) {
            p.panelsPlan += source.qty;
            p.panelsDone += done;
          }
        } else if (!isFrame && !isPanel) {
          p.plan += source.qty;
          p.done += done;
        }
        pfOf.set(key, p);
      }
      continue;
    }

    if (r.order_line_id == null) continue;
    const key = `${r.order_id}|${r.order_line_id}`;
    const op = r.operation ?? r.area;
    // порядок столбцов: этап маршрута, при равных — участок по срокам плана (раньше начинается — левее)
    const seq = (r.op_seq ?? 1000) * 1000 + (areaSort.get(r.area) ?? 999);
    opSeq.set(op, Math.min(opSeq.get(op) ?? seq, seq));
    let l = lines.get(key);
    if (!l) {
      const o = orderBy.get(r.order_id);
      l = {
        key,
        order_id: r.order_id,
        order_name: o ? `№${o.id} «${o.name}»` : `№${r.order_id}`,
        ship: o?.ship_date ?? null,
        launch: r.launch_date ?? null,
        invoice: r.invoice_no ?? "",
        series: r.series ?? "",
        size: r.size ?? "",
        color: r.color ?? "",
        source: r.source || r.position,
        qty: r.line_qty ?? r.plan,
        ops: {},
        pf: { plan: 0, done: 0, framesPlan: 0, framesDone: 0, panelsPlan: 0, panelsDone: 0, readySets: 0, totalSets: 0 },
        left: 0,
      };
      lines.set(key, l);
    }
    (l.ops[op] ??= []).push(r);
  }

  const ops = [...opSeq.entries()].sort((a, b) => a[1] - b[1]).map(([op]) => op);

  for (const l of lines.values()) {
    const p = pfOf.get(l.key) ?? {
      plan: 0,
      done: 0,
      framesPlan: 0,
      framesDone: 0,
      panelsPlan: 0,
      panelsDone: 0,
      readySets: 0,
      totalSets: 0,
    };

    // На 1 дверь идёт 2 панели и 1 каркас
    const setsFromPanels = p.panelsPlan > 0 ? Math.floor(p.panelsDone / 2) : Infinity;
    const totalSetsFromPanels = p.panelsPlan > 0 ? Math.floor(p.panelsPlan / 2) : Infinity;
    const setsFromFrames = p.framesPlan > 0 ? p.framesDone : Infinity;
    const totalSetsFromFrames = p.framesPlan > 0 ? p.framesPlan : Infinity;

    const readySets = Math.min(
      setsFromPanels !== Infinity ? setsFromPanels : l.qty,
      setsFromFrames !== Infinity ? setsFromFrames : l.qty,
    );
    const totalSets = Math.min(
      totalSetsFromPanels !== Infinity ? totalSetsFromPanels : l.qty,
      totalSetsFromFrames !== Infinity ? totalSetsFromFrames : l.qty,
    );

    p.readySets = readySets;
    p.totalSets = totalSets > 0 ? totalSets : l.qty;
    p.done = readySets;
    p.plan = p.totalSets;
    l.pf = p;

    // Вычисляем оставшееся строго по финальной операции маршрута ДАННОЙ позиции!
    const myOps = ops.filter((op) => l.ops[op]?.length);
    if (myOps.length > 0) {
      const myLastOp = myOps[myOps.length - 1];
      const rs = l.ops[myLastOp] || [];
      l.left = rs.reduce((s, r) => s + (r.closed ? 0 : Math.max(0, r.plan - r.good)), 0);
    } else {
      l.left = l.qty;
    }
  }

  return { lines: [...lines.values()], ops };
}

const sumOp = (rs: MonitorRow[] = []) => ({
  plan: rs.reduce((s, r) => s + r.plan, 0),
  done: rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0),
  defect: rs.reduce((s, r) => s + r.defect, 0),
});

export function OpCell({ rs, ready, onOpenTask }: { rs: MonitorRow[] | undefined; ready?: number; onOpenTask: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  if (!rs?.length) return <Typography.Text type="secondary">—</Typography.Text>;
  const s = sumOp(rs);
  const full = s.done >= s.plan - 1e-9;
  const pct = s.plan > 0 ? Math.round((s.done / s.plan) * 100) : 100;
  const text = (
    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500, color: full ? "#389e0d" : s.done > 0 ? "#C97A2B" : undefined }}>
      {r2(s.done)}
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        /{r2(s.plan)}
      </Typography.Text>
      {s.defect > 0 && <Typography.Text type="danger" style={{ fontSize: 11 }}> б{r2(s.defect)}</Typography.Text>}
      {(ready ?? 0) > 0 && (
        <span style={{ display: "block", fontSize: 10, fontWeight: 400, color: "#389e0d", lineHeight: 1 }}>ждёт {r2(ready!)}</span>
      )}
    </span>
  );

  const quick = rs.filter((r) => r.quick);
  const tipContent = (
    <div>
      <div><b>Этап «{rs[0]?.operation || "—"}»</b></div>
      <div>• Сдано: <b>{r2(s.done)}</b> из <b>{r2(s.plan)} шт</b> ({pct}%)</div>
      <div>• Осталось сделать: {r2(Math.max(0, s.plan - s.done))} шт</div>
      {s.defect > 0 && <div style={{ color: "#ff4d4f" }}>• Брак: {r2(s.defect)} шт</div>}
      {(ready ?? 0) > 0 && (
        <div style={{ color: "#52c41a", marginTop: 2 }}>
          • Задел к след. этапу: <b>{r2(ready!)} шт</b> (сдано здесь, ждёт приёмки)
        </div>
      )}
      <div style={{ marginTop: 4, fontSize: 11, color: "#8c8c8c" }}>
        Клик: {quick.length > 0 ? "быстрый отчёт" : `открыть задание №${rs[0]?.task_id}`}
      </div>
    </div>
  );

  if (!quick.length) {
    return (
      <Tooltip title={tipContent}>
        <Button type="text" size="small" style={{ padding: "0 4px" }} onClick={() => onOpenTask(rs[0].task_id)}>
          {text}
        </Button>
      </Tooltip>
    );
  }

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      title="Отчёт по операции"
      content={
        <Space orientation="vertical">
          <BatchQuickReport rows={quick} onDone={() => setOpen(false)} />
          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => onOpenTask(rs[0].task_id)}>
            открыть задание №{rs[0].task_id}
          </Button>
        </Space>
      }
    >
      <Tooltip title={tipContent}>
        <Button type="text" size="small" style={{ padding: "0 4px" }} aria-label="Внести отчёт">
          {text}
        </Button>
      </Tooltip>
    </Popover>
  );
}

export function OpGroupCell({ ls, op, onOpenTask }: { ls: LineRec[]; op: string; onOpenTask?: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const rs = ls.flatMap((l) => l.ops[op] ?? []);
  if (!rs.length) return null;
  const s = sumOp(rs);
  if (!s.plan) return null;
  const quick = rs.filter((r) => r.quick);
  const full = s.done >= s.plan - 1e-9;
  const pct = s.plan > 0 ? Math.round((s.done / s.plan) * 100) : 100;
  const text = (
    <span style={{ fontVariantNumeric: "tabular-nums", color: full ? "#389e0d" : s.done > 0 ? "#C97A2B" : undefined, fontWeight: 600 }}>
      {r2(s.done)}/{r2(s.plan)}
      {s.defect > 0 && <span style={{ color: "#ff4d4f", fontSize: 11 }}> б{r2(s.defect)}</span>}
    </span>
  );

  const tip = (
    <div>
      <div><b>Группа «{op}»</b></div>
      <div>• Всего сдано: <b>{r2(s.done)}</b> из <b>{r2(s.plan)} шт</b> ({pct}%)</div>
      <div>• Осталось сделать: {r2(Math.max(0, s.plan - s.done))} шт</div>
      {s.defect > 0 && <div style={{ color: "#ff4d4f" }}>• Брак: {r2(s.defect)} шт</div>}
      <div style={{ marginTop: 4, fontSize: 11, color: "#8c8c8c" }}>
        Клик: {quick.length > 0 ? "быстрый отчёт и состав позиций" : "просмотр задания"}
      </div>
    </div>
  );

  return (
    <Tooltip title={tip}>
      {quick.length > 0 ? (
        <Popover
          trigger="click"
          open={open}
          onOpenChange={setOpen}
          title={`Группа: ${op}`}
          content={<BatchQuickReport rows={quick} title={op} onDone={() => setOpen(false)} />}
        >
          <Button type="text" size="small" style={{ padding: "0 4px" }} title="Быстрый отчёт и состав позиций">
            {text}
          </Button>
        </Popover>
      ) : (
        <Button
          type="text"
          size="small"
          style={{ padding: "0 4px" }}
          onClick={() => {
            if (rs[0]?.task_id && onOpenTask) onOpenTask(rs[0].task_id);
          }}
        >
          {text}
        </Button>
      )}
    </Tooltip>
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
  const flow = useMemo(() => computeFlow(lines, ops), [lines, ops]);
  const [stage, setStage] = useState<string | null>(null);
  const stageOn = stage && ops.includes(stage) ? stage : null;
  const [flowMapOrders, setFlowMapOrders] = useState<Set<number>>(new Set());

  const toggleFlowMap = (orderId: number) => {
    setFlowMapOrders((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

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
    { key: "invoice", title: "Счёт", width: 140, sortValue: (l) => l.invoice, render: (_, l) => <span style={{ whiteSpace: "nowrap" }}>{l.invoice}</span> },
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
      render: (_, l) => (
        <Tooltip title={`Общий план заказа по этой позиции: ${r2(l.qty)} шт`}>
          <b>{r2(l.qty)}</b>
        </Tooltip>
      ),
      groupRender: (rs) => <b>{r2(rs.reduce((s, l) => s + l.qty, 0))}</b>,
    },
    {
      key: "left",
      title: "Осталось",
      width: 96,
      align: "right",
      sortValue: (l) => l.left,
      render: (_, l) => (
        <Tooltip
          title={
            l.left > 0
              ? `Осталось изготовить по финальной операции: ${r2(l.left)} шт. из ${r2(l.qty)}`
              : "Все операции маршрута выполнены — позиция полностью готова!"
          }
        >
          {l.left > 0 ? <b>{r2(l.left)}</b> : <Tag color="green">готово</Tag>}
        </Tooltip>
      ),
      groupRender: (rs) => <b>{r2(rs.reduce((s, l) => s + l.left, 0))}</b>,
    },
    {
      key: "pf",
      title: "П/ф к склейке",
      width: 140,
      align: "center",
      render: (_, l) => {
        if (!l.pf.totalSets) return <Typography.Text type="secondary">—</Typography.Text>;
        const fDone = r2(l.pf.framesDone);
        const fPlan = r2(l.pf.framesPlan);
        const pDone = r2(l.pf.panelsDone);
        const pPlan = r2(l.pf.panelsPlan);
        const isFull = l.pf.readySets >= l.pf.totalSets;
        return (
          <Tooltip
            title={
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Готовность комплектов полуфабрикатов к склейке:</div>
                <div>• Каркасы (собраны): {fDone} из {fPlan} шт. ({fPlan > 0 ? Math.round((fDone / fPlan) * 100) : 100}%)</div>
                <div>• Облицовочные панели (готовы): {pDone} из {pPlan} шт. (по 2 панели на дверь)</div>
                {l.pf.panelsLaminated != null && l.pf.panelsLaminated > pDone && (
                  <div>• Панелей на ламинации сдано: {r2(l.pf.panelsLaminated)} шт. (ожидают фрезеровки)</div>
                )}
                <div style={{ marginTop: 6, borderTop: "1px dashed rgba(255,255,255,0.4)", paddingTop: 4 }}>
                  <b>Полных комплектов к склейке:</b><br />
                  min(каркасы: {fDone}, панели / 2: {r2(Math.floor(pDone / 2))}) = <b>{l.pf.readySets} из {l.pf.totalSets} комплектов</b>
                </div>
              </div>
            }
          >
            <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 11, lineHeight: 1.3 }}>
              <div>К: <b>{fDone}</b>/{fPlan}</div>
              <div>
                П: <b>{pDone}</b>/{pPlan}
                <Tag
                  color={isFull ? "green" : l.pf.readySets > 0 ? "orange" : "default"}
                  style={{ marginLeft: 4, marginInlineEnd: 0, padding: "0 3px", fontSize: 10, lineHeight: "14px" }}
                >
                  {l.pf.readySets} компл
                </Tag>
              </div>
            </div>
          </Tooltip>
        );
      },
      groupRender: (rs) => {
        const fDone = rs.reduce((s, l) => s + l.pf.framesDone, 0);
        const fPlan = rs.reduce((s, l) => s + l.pf.framesPlan, 0);
        const pDone = rs.reduce((s, l) => s + l.pf.panelsDone, 0);
        const pPlan = rs.reduce((s, l) => s + l.pf.panelsPlan, 0);
        const totalSets = rs.reduce((s, l) => s + l.pf.readySets, 0);
        if (!fPlan && !pPlan) return null;
        return (
          <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 11, lineHeight: 1.2 }}>
            <span>К: <b>{r2(fDone)}</b>/{r2(fPlan)}</span> · <span>П: <b>{r2(pDone)}</b>/{r2(pPlan)}</span>
            <Tag
              color={fDone >= fPlan && pDone >= pPlan ? "green" : totalSets > 0 ? "orange" : "default"}
              style={{ marginLeft: 4, marginInlineEnd: 0, padding: "0 4px", fontSize: 10, lineHeight: "14px" }}
            >
              {totalSets} компл
            </Tag>
          </div>
        );
      },
    },
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
        width: 100,
        align: "center",
        sortValue: (l) => {
          const s = sumOp(l.ops[op]);
          return s.plan ? s.done / s.plan : -1;
        },
        render: (_, l) => <OpCell rs={l.ops[op]} ready={flow.byLine.get(l.key)?.[op]?.ready} onOpenTask={onOpenTask} />,
        groupRender: (ls) => <OpGroupCell ls={ls} op={op} onOpenTask={onOpenTask} />,
      }),
    ),
  ];

  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <FlowStrip flow={flow} active={stageOn} onPick={setStage} />
      {stageOn && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Показаны позиции на этапе «{stageOn}» (готово к передаче или в работе) —{" "}
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
        scroll={{
          x: 140 + 80 + 90 + 150 + 240 + 76 + 96 + 140 + ops.length * 100 + 40,
          y: "calc(100vh - 360px)",
        }}
        columns={columns}
        renderGroupHeaderExtra={(g) => {
          if (g.dim.key !== "order") return null;
          const orderId = g.rows[0]?.order_id;
          if (!orderId) return null;
          const isOpen = flowMapOrders.has(orderId);
          return (
            <Button
              size="small"
              type={isOpen ? "primary" : "default"}
              icon={<ApartmentOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                toggleFlowMap(orderId);
              }}
              style={{ marginLeft: 6, fontSize: 11 }}
            >
              {isOpen ? "Свернуть карту" : "Карта движения"}
            </Button>
          );
        }}
        renderGroupContent={(g) => {
          if (g.dim.key !== "order") return null;
          const orderId = g.rows[0]?.order_id;
          if (!orderId || !flowMapOrders.has(orderId)) return null;
          const o = g.rows[0];
          return (
            <OrderFlowMap
              orderId={orderId}
              orderName={o.order_name}
              shipDate={o.ship}
              launchDate={o.launch}
              lines={g.rows}
              allRows={rows}
              ops={ops}
              onOpenTask={onOpenTask}
              onClose={() => toggleFlowMap(orderId)}
            />
          );
        }}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            клик по клетке операции — отчёт; <Link to="/production-orders">заказы →</Link>
          </Typography.Text>
        }
      />
    </Space>
  );
}
