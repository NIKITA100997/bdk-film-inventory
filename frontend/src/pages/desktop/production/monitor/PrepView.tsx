import { useMemo, useState } from "react";
import { Alert, Button, Space, Tag, Tooltip, Typography } from "antd";
import type { MonitorArea, MonitorOrder, MonitorRow } from "../../../../api/productionMonitor";
import GroupedTable, { type GroupColumn } from "../../../../components/GroupedTable";
import { OpCell, OpGroupCell, type LineRec } from "./OrdersView";
import { computeFlow, FlowStrip } from "./flow";

const r2 = (v: number) => Math.round(v * 100) / 100;

const FILM_OK = new Set(["issued", "covered", "site_stock"]);
function FilmCell({ rs }: { rs: MonitorRow[] }) {
  const open = rs.filter((r) => !r.closed && r.plan - r.good > 0);
  const totalDeficit = rs.reduce((s, r) => s + (r.film_deficit_m ?? 0), 0);
  if (!open.length) {
    if (totalDeficit > 0) {
      return (
        <Tooltip title={`Овердрафт штрипсов в пуле участка: накоплен дефицит ${r2(totalDeficit)} м`}>
          <Tag color="error" style={{ marginInlineEnd: 0 }}>дефицит -{r2(totalDeficit)} м</Tag>
        </Tooltip>
      );
    }
    return rs.length ? <Typography.Text type="secondary">—</Typography.Text> : null;
  }
  const ok = open.filter((r) => FILM_OK.has(r.film_status ?? "")).length;
  const partial = open.filter((r) => r.film_status === "partial").length;
  const toIssue = open.reduce((s, r) => s + (FILM_OK.has(r.film_status ?? "") ? 0 : r.film_to_issue_m ?? 0), 0);
  const [color, text] = ok === open.length ? ["green", "выдана"] : ok === 0 && partial === 0 ? ["red", "не выдана"] : ["orange", `${ok} из ${open.length}`];
  return (
    <Space size={2} direction="vertical" align="center">
      <Tooltip title={`Строк с плёнкой в работе: ${open.length}; выдано: ${ok}${toIssue > 0 ? `; ещё выдать ${r2(toIssue)} м` : ""}`}>
        <Tag color={color} style={{ marginInlineEnd: 0 }}>
          {text}
        </Tag>
      </Tooltip>
      {totalDeficit > 0 && (
        <Tooltip title={`Овердрафт штрипсов в пуле участка: списано в дефицит ${r2(totalDeficit)} м`}>
          <Tag color="error" style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>
            -{r2(totalDeficit)} м
          </Tag>
        </Tooltip>
      )}
    </Space>
  );
}

/** Этапы до склейки щитов по ходу работ (23.10). */
function stageOf(r: MonitorRow, areaName: Map<string, string>): { label: string; seq: number } {
  const op = (r.operation ?? "").toLowerCase();
  if (op.includes("сборка каркас")) return { label: "Сборка каркаса", seq: 10 };
  if (op.includes("распил")) return { label: "Распил заготовок", seq: 20 };
  if (op.includes("шлифов")) return { label: "Шлифовка", seq: 40 };
  if (op.includes("ламинац") || op.includes("окутк") || r.area === "fabrika" || r.area === "uchastok_membranno_vakuumnykh_pressov") {
    return r.area === "fabrika" ? { label: "Ламинация (Фабрика)", seq: 51 } : { label: "Ламинация (прессы)", seq: 50 };
  }
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

function getReadyToGlue(l: LineRec, opsList: string[]): { readyPcs: number; readySets: number; isPanel: boolean; formula: string } {
  const isPanel = /панел/i.test(l.invoice) || /панел/i.test(l.source);
  const isFrame = /каркас/i.test(l.invoice) || /каркас/i.test(l.source);

  let finalOp = "";
  if (isPanel) {
    if (l.ops["Фрезеровка ламинир."]?.length) finalOp = "Фрезеровка ламинир.";
    else if (l.ops["Ламинация (Фабрика)"]?.length) finalOp = "Ламинация (Фабрика)";
    else if (l.ops["Ламинация (прессы)"]?.length) finalOp = "Ламинация (прессы)";
    else finalOp = opsList.filter((op) => l.ops[op]?.length).pop() || "";
  } else if (isFrame) {
    if (l.ops["Сборка каркаса"]?.length) finalOp = "Сборка каркаса";
    else finalOp = opsList.filter((op) => l.ops[op]?.length).pop() || "";
  } else {
    finalOp = opsList.filter((op) => l.ops[op]?.length).pop() || "";
  }

  const rs = l.ops[finalOp] || [];
  const readyPcs = rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
  const readySets = isPanel ? Math.floor(readyPcs / 2) : readyPcs;

  const formula = isPanel
    ? `Готово облицовочных панелей по этапу «${finalOp}»: ${r2(readyPcs)} шт. На 1 дверь идёт 2 панели: ${r2(readyPcs)} / 2 = ${readySets} комплектов дверей.`
    : `Готово каркасов по этапу «${finalOp}»: ${r2(readyPcs)} шт. На 1 дверь идёт 1 каркас = ${readySets} комплектов дверей.`;

  return { readyPcs, readySets, isPanel, formula };
}

/** «Подготовка к склейке» (23.10): каркасы и панели под щитовые двери по этапам. */
export default function PrepView({
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
  const { lines, ops, colorsOf } = useMemo(() => {
    const areaName = new Map(areas.map((a) => [a.code, a.name]));
    const orderBy = new Map(orders.map((o) => [o.id, o]));
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
          key,
          order_id: r.order_id,
          order_name: o ? `№${o.id} «${o.name}»` : `№${r.order_id}`,
          ship: o?.ship_date ?? null,
          launch: r.launch_date ?? null,
          invoice: pk.kind,
          series: "",
          size: pk.size,
          color: "",
          source: `${pk.kind === "Каркасы" ? "Каркас" : pk.kind === "Панели" ? "Панель" : ""} ${pk.size}`.trim(),
          qty: 0,
          ops: {},
          pf: { plan: 0, done: 0, framesPlan: 0, framesDone: 0, panelsPlan: 0, panelsDone: 0, readySets: 0, totalSets: 0 },
          left: 0,
        };
        map.set(key, l);
      }
      (l.ops[st.label] ??= []).push({ ...r, op_seq: st.seq });
      if (/панель/i.test(r.position)) {
        const c = r.position.match(/\(([^)]*)\)/)?.[1] || r.film || r.color;
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
        if (hideDone && l.left <= 0) return false;
        if (!stageOn) return true;
        const f = lineFlow(l.key, stageOn);
        return !!f && (f.ready > 0 || f.inWork > 0);
      }),
    [lines, hideDone, stageOn, flows],
  );

  const orderSummary = useMemo(() => {
    let framesReady = 0;
    let framesPlan = 0;
    let panelsReady = 0;
    let panelsPlan = 0;
    for (const l of lines) {
      const { readyPcs, isPanel } = getReadyToGlue(l, ops);
      if (isPanel) {
        panelsReady += readyPcs;
        panelsPlan += l.qty;
      } else {
        framesReady += readyPcs;
        framesPlan += l.qty;
      }
    }
    const doorSetsReady = Math.min(
      framesPlan > 0 ? framesReady : Infinity,
      panelsPlan > 0 ? Math.floor(panelsReady / 2) : Infinity,
    );
    const doorSetsTotal = Math.min(
      framesPlan > 0 ? framesPlan : Infinity,
      panelsPlan > 0 ? Math.floor(panelsPlan / 2) : Infinity,
    );
    return {
      framesReady,
      framesPlan,
      panelsReady,
      panelsPlan,
      doorSetsReady: doorSetsReady !== Infinity ? doorSetsReady : 0,
      doorSetsTotal: doorSetsTotal !== Infinity ? doorSetsTotal : 0,
    };
  }, [lines, ops]);

  if (!lines.length)
    return <Alert type="info" showIcon message="Нет открытых заданий на каркасы и панели под щитовые двери" />;

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
          <Space orientation="vertical" size={0}>
            <b>{l.source}</b>
            {cs.length > 0 && (
              <Tooltip title={cs.join("; ")}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  декоров/цветов: {cs.length}
                </Typography.Text>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      key: "qty",
      title: "Кол-во",
      width: 80,
      align: "right",
      sortValue: (l) => l.qty,
      render: (_, l) => {
        const isPanel = /панел/i.test(l.invoice) || /панел/i.test(l.source);
        return (
          <Tooltip title={isPanel ? `План: ${r2(l.qty)} панелей (на ${r2(Math.floor(l.qty / 2))} дверей)` : `План: ${r2(l.qty)} каркасов`}>
            <b>{r2(l.qty)}</b>
          </Tooltip>
        );
      },
      groupRender: (ls) => <b>{r2(ls.reduce((s, l) => s + l.qty, 0))}</b>,
    },
    // Колонка ПЛЁНКИ перенесена в подготовку к склейке
    {
      key: "film",
      title: "Плёнка",
      width: 104,
      align: "center",
      render: (_, l) => {
        const filmRows = Object.values(l.ops).flat().filter((r) => r.film_status || r.film);
        if (!filmRows.length) return <Typography.Text type="secondary">—</Typography.Text>;
        return <FilmCell rs={filmRows} />;
      },
    },
    ...ops.map(
      (op): GroupColumn<LineRec> => ({
        key: `op:${op}`,
        title: <span style={{ whiteSpace: "normal", fontSize: 12 }}>{op}</span>,
        width: 104,
        align: "center",
        render: (_, l) => <OpCell rs={l.ops[op]} ready={lineFlow(l.key, op)?.ready} onOpenTask={onOpenTask} />,
        groupRender: (ls) => <OpGroupCell ls={ls} op={op} onOpenTask={onOpenTask} />,
      }),
    ),
    {
      key: "toglue",
      title: <span style={{ whiteSpace: "normal", fontSize: 12 }}>Готово к склейке</span>,
      width: 120,
      align: "right",
      render: (_, l) => {
        const { readyPcs, readySets, isPanel, formula } = getReadyToGlue(l, ops);
        if (readyPcs <= 0) return <Typography.Text type="secondary">0</Typography.Text>;
        return (
          <Tooltip title={formula}>
            <Tag color="green" style={{ cursor: "help" }}>
              {r2(readyPcs)} шт {isPanel ? `(${readySets} дв.)` : `(${readySets} дв.)`}
            </Tag>
          </Tooltip>
        );
      },
      groupRender: (ls) => {
        const total = ls.reduce((s, l) => s + getReadyToGlue(l, ops).readyPcs, 0);
        return <b>{r2(total)} шт</b>;
      },
    },
  ];

  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      {orderSummary.doorSetsTotal > 0 && (
        <div
          style={{
            background: "#f6ffed",
            border: "1px solid #b7eb8f",
            borderRadius: 8,
            padding: "8px 14px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
          <div>
            <Typography.Text strong style={{ fontSize: 13, color: "#237804" }}>
              Готовность комплектов к склейке:
            </Typography.Text>
            <span style={{ fontSize: 13, marginLeft: 8 }}>
              <b>{orderSummary.doorSetsReady}</b> из <b>{orderSummary.doorSetsTotal} комплектов дверей</b>{" "}
              ({orderSummary.doorSetsTotal > 0 ? Math.round((orderSummary.doorSetsReady / orderSummary.doorSetsTotal) * 100) : 100}%)
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#595959", display: "flex", gap: 16 }}>
            <span>• Каркасы (собрано): <b>{r2(orderSummary.framesReady)}</b> из {r2(orderSummary.framesPlan)} шт</span>
            <span>• Облицовочные панели (с ламинацией): <b>{r2(orderSummary.panelsReady)}</b> из {r2(orderSummary.panelsPlan)} шт (по 2 на дверь = {r2(Math.floor(orderSummary.panelsReady / 2))} компл.)</span>
          </div>
        </div>
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
        scroll={{ x: 220 + 80 + 104 + ops.length * 104 + 120 + 40, y: "calc(100vh - 360px)" }}
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
