import { useMemo, useState } from "react";
import { Alert, Button, Space, Tag, Tooltip, Typography } from "antd";
import type { MonitorArea, MonitorOrder, MonitorRow } from "../../../../api/productionMonitor";
import GroupedTable, { type GroupColumn } from "../../../../components/GroupedTable";
import { OpCell, type LineRec } from "./OrdersView";
import { computeFlow, FlowStrip } from "./flow";

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Этапы до склейки щитов по ходу работ (23.10). Распил и фрезеровка — по
 * заготовке МДФ, шлифовка и ламинация — уже по панели нужного цвета: цепочку
 * связываем по заказу и размеру (заготовка 6х610х2010 → панели 6х610х2010). */
function stageOf(r: MonitorRow, areaName: Map<string, string>): { label: string; seq: number } {
  const op = (r.operation ?? "").toLowerCase();
  if (op.includes("сборка каркас")) return { label: "Сборка каркаса", seq: 10 };
  if (op.includes("распил")) return { label: "Распил", seq: 20 };
  if (op.includes("шлифов")) return { label: "Шлифовка", seq: 40 };
  if (op.includes("ламинац") || op.includes("окутк"))
    return r.area === "fabrika" ? { label: "Ламинация (Фабрика)", seq: 51 } : { label: "Ламинация (прессы)", seq: 50 };
  if (op.includes("фрезер")) {
    return r.area === "frezerovka_laminirovannykh_paneley"
      ? { label: "Фрезеровка ламинир.", seq: 60 }
      : { label: "Фрезеровка", seq: 30 };
  }
  return { label: r.operation ?? areaName.get(r.area) ?? r.area, seq: 90 };
}
const SIZE = /(\d+(?:[.,]\d+)?)\s*[хx]\s*(\d+)\s*[хx]\s*(\d+)/i;
function partKey(position: string): { kind: string; size: string } {
  const m = position.match(SIZE);
  const size = m ? `${m[1]}х${m[2]}х${m[3]}` : position;
  if (/каркас/i.test(position)) return { kind: "Каркасы", size };
  if (/панел|заготовка мдф/i.test(position)) return { kind: "Панели", size };
  return { kind: "Прочие п/ф", size: position };
}

/** «Подготовка к склейке» (23.10): каркасы и панели под щитовые двери по
 * этапам — готово к передаче, в работе, итого; строка — заказ × размер. */
export default function PrepView({
  rows,
  orders,
  areas,
  onOpenTask,
}: {
  rows: MonitorRow[];
  orders: MonitorOrder[];
  areas: MonitorArea[];
  onOpenTask: (id: number) => void;
}) {
  const { lines, ops, colorsOf } = useMemo(() => {
    const areaName = new Map(areas.map((a) => [a.code, a.name]));
    const orderBy = new Map(orders.map((o) => [o.id, o]));
    // заказы со щитовыми дверями — их п/ф (сама деталь может быть «панелью» по виду продукции)
    const shieldOrders = new Set(rows.filter((r) => r.part_id == null && r.direction === "shield").map((r) => r.order_id));
    const map = new Map<string, LineRec>();
    const seqOf = new Map<string, number>();
    const colors = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.part_id == null || r.order_id == null || !shieldOrders.has(r.order_id)) continue;
      const st = stageOf(r, areaName);
      const pk = partKey(r.position);
      const key = `${r.order_id}|${pk.kind}|${pk.size}`;
      seqOf.set(st.label, st.seq);
      let l = map.get(key);
      if (!l) {
        const o = orderBy.get(r.order_id);
        l = {
          key, order_id: r.order_id, order_name: o ? `№${o.id} «${o.name}»` : `№${r.order_id}`, ship: o?.ship_date ?? null,
          launch: r.launch_date ?? null, invoice: pk.kind, series: "", size: pk.size, color: "", source: `${pk.kind === "Каркасы" ? "Каркас" : pk.kind === "Панели" ? "Панель" : ""} ${pk.size}`.trim(),
          qty: 0, ops: {}, pf: { plan: 0, done: 0 }, left: 0, film: [],
        };
        map.set(key, l);
      }
      (l.ops[st.label] ??= []).push({ ...r, op_seq: st.seq });
      if (/панель/i.test(r.position)) {
        const c = r.position.match(/\(([^)]*)\)/)?.[1];
        if (c) (colors.get(key) ?? colors.set(key, new Set()).get(key)!).add(c);
      }
    }
    const opsList = [...seqOf.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
    for (const l of map.values()) {
      const firstOp = opsList.find((op) => l.ops[op]?.length);
      l.qty = firstOp ? l.ops[firstOp].reduce((s, r) => s + r.plan, 0) : 0;
      const lastOp = [...opsList].reverse().find((op) => l.ops[op]?.length);
      l.left = lastOp ? l.ops[lastOp].reduce((s, r) => s + (r.closed ? 0 : Math.max(0, r.plan - r.good)), 0) : 0;
    }
    return { lines: [...map.values()], ops: opsList, colorsOf: colors };
  }, [rows, orders, areas]);
  // поток — отдельно по каркасам и по панелям (у каждого своя цепочка и своё итого)
  const flows = useMemo(() => {
    const kinds = [...new Set(lines.map((l) => l.invoice))];
    return kinds.map((k) => {
      const ls = lines.filter((l) => l.invoice === k);
      return { kind: k, flow: computeFlow(ls, ops.filter((op) => ls.some((l) => l.ops[op]?.length))) };
    });
  }, [lines, ops]);
  const lineFlow = (key: string, op: string) => {
    for (const f of flows) {
      const v = f.flow.byLine.get(key)?.[op];
      if (v) return v;
    }
    return undefined;
  };
  const [stage, setStage] = useState<string | null>(null);
  const stageOn = stage && ops.includes(stage) ? stage : null;
  const data = useMemo(
    () =>
      lines.filter((l) => {
        if (!stageOn) return true;
        const f = lineFlow(l.key, stageOn);
        return !!f && (f.ready > 0 || f.inWork > 0);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, stageOn, flows],
  );
  if (!lines.length)
    return <Alert type="info" showIcon message="Нет открытых заданий на каркасы и панели под щитовые двери" />;
  const nothingReported = lines.every((l) => Object.values(l.ops).every((rs) => rs.every((r) => !r.good)));
  const columns: GroupColumn<LineRec>[] = [
    {
      key: "name",
      title: "Позиция",
      width: 220,
      fixed: "left",
      sortValue: (l) => l.source,
      render: (_, l) => {
        const cs = [...(colorsOf.get(l.key) ?? [])];
        return (
          <Space direction="vertical" size={0}>
            <b>{l.source}</b>
            {cs.length > 0 && (
              <Tooltip title={cs.join("; ")}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  цветов: {cs.length}
                </Typography.Text>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    { key: "qty", title: "Кол-во", width: 80, align: "right", sortValue: (l) => l.qty, render: (_, l) => <b>{r2(l.qty)}</b>,
      groupRender: (ls) => <b>{r2(ls.reduce((s, l) => s + l.qty, 0))}</b> },
    ...ops.map(
      (op): GroupColumn<LineRec> => ({
        key: `op:${op}`,
        title: <span style={{ whiteSpace: "normal", fontSize: 12 }}>{op}</span>,
        width: 104,
        align: "center",
        render: (_, l) => <OpCell rs={l.ops[op]} ready={lineFlow(l.key, op)?.ready} onOpenTask={onOpenTask} />,
        groupRender: (ls) => {
          const rs = ls.flatMap((l) => l.ops[op] ?? []);
          if (!rs.length) return null;
          const plan = rs.reduce((s, r) => s + r.plan, 0);
          const done = rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
          return <span style={{ fontVariantNumeric: "tabular-nums" }}>{r2(done)}/{r2(plan)}</span>;
        },
      }),
    ),
    {
      key: "toglue",
      title: <span style={{ whiteSpace: "normal", fontSize: 12 }}>Готово к склейке</span>,
      width: 96,
      align: "right",
      render: (_, l) => {
        const done = l.qty - l.left;
        return done > 0 ? <Tag color="green">{r2(done)}</Tag> : <Typography.Text type="secondary">0</Typography.Text>;
      },
      groupRender: (ls) => <b>{r2(ls.reduce((s, l) => s + (l.qty - l.left), 0))}</b>,
    },
  ];
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      {nothingReported && (
        <Alert
          type="warning"
          showIcon
          message="По этапам до склейки ещё не отчитывались"
          description="Цифры «готово» появятся, когда участки начнут вносить отчёты: распил, шлифовка, сборка каркасов — прямо отсюда (клик по клетке), ламинация — в задании (нужен рулон)."
        />
      )}
      {flows.map((f) => (
        <FlowStrip key={f.kind} title={f.kind} flow={f.flow} active={stageOn} onPick={setStage} />
      ))}
      {stageOn && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Показаны позиции на этапе «{stageOn}» —{" "}
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setStage(null)}>
            показать все
          </Button>
        </Typography.Text>
      )}
      <GroupedTable<LineRec>
        storageKey="monitor.prep"
        dims={[
          { key: "kind", label: "Вид", value: (l) => l.invoice },
          { key: "order", label: "Заказ", value: (l) => l.order_name },
          { key: "size", label: "Размер", value: (l) => l.size },
        ]}
        defaultDims={["kind", "order"]}
        labelColumn="name"
        size="small"
        rowKey={(l) => l.key}
        dataSource={data}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: 220 + 80 + ops.length * 104 + 96 + 40, y: "calc(100vh - 450px)" }}
        columns={columns}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            распил и фрезеровка — по заготовке МДФ, дальше — по панели цвета; связаны по заказу и размеру
          </Typography.Text>
        }
      />
    </Space>
  );
}
