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
  if (/панел|накладк|заготовк|мдф|скин/i.test(position)) return { kind: "Панели", size };
  return { kind: "Прочие п/ф", size: position };
}

function getReadyToGlue(l: LineRec, opsList: string[]): {
  readyPcs: number;
  readySets: number;
  isPanel: boolean;
  formula: string;
  laminatedPcs: number;
} {
  const isPanel = /панел|накладк|заготовк|мдф|скин/i.test(l.invoice) || /панел|накладк|заготовк|мдф|скин/i.test(l.source);
  const isFrame = /каркас/i.test(l.invoice) || /каркас/i.test(l.source);

  if (isFrame) {
    const finalOp = l.ops["Сборка каркаса"]?.length ? "Сборка каркаса" : opsList.filter((op) => l.ops[op]?.length).pop() || "";
    const rs = l.ops[finalOp] || [];
    const readyPcs = rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
    const readySets = readyPcs;
    const formula = `Готово каркасов по этапу «${finalOp}»: ${r2(readyPcs)} шт. На 1 дверь идёт 1 каркас = ${readySets} комплектов дверей.`;
    return { readyPcs, readySets, isPanel: false, formula, laminatedPcs: 0 };
  }

  if (isPanel) {
    // Для панелей детали могут иметь разный маршрут:
    // Модели с рисунком идут на фрезеровку после ламинации, а глухие (напр. Щ-12) готовы к склейке сразу после ламинации!
    const millingRows = l.ops["Фрезеровка ламинир."] || [];
    const lamRows = [
      ...(l.ops["Ламинация (Фабрика)"] || []),
      ...(l.ops["Ламинация (прессы)"] || []),
    ];

    const laminatedPcs = lamRows.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);

    // Определяем модели, для которых в заказе заведена фрезеровка
    const millingModels = new Set(
      millingRows.map((r) => (r.position.match(/^([^\s,]+)/)?.[1] || r.position).toLowerCase())
    );

    let readyPcs = 0;
    // 1. По деталям с фрезеровкой — готовность берется с фрезеровки
    for (const r of millingRows) {
      readyPcs += r.closed ? r.plan : Math.min(r.good, r.plan);
    }
    // 2. По деталям БЕЗ фрезеровки (глухие щитовые накладки, напр. Щ-12) — готовы сразу после ламинации
    for (const r of lamRows) {
      const model = (r.position.match(/^([^\s,]+)/)?.[1] || r.position).toLowerCase();
      if (!millingModels.has(model)) {
        readyPcs += r.closed ? r.plan : Math.min(r.good, r.plan);
      }
    }

    // Если нет ни ламинации, ни фрезеровки — fallback на последнюю доступную операцию
    if (!millingRows.length && !lamRows.length) {
      const finalOp = opsList.filter((op) => l.ops[op]?.length).pop() || "";
      const rs = l.ops[finalOp] || [];
      readyPcs = rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
    }

    const readySets = Math.floor(readyPcs / 2);
    const millingGood = millingRows.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
    const formula = `Готово облицовочных панелей к склейке: ${r2(readyPcs)} шт. (на 1 дверь 2 панели = ${readySets} компл. дверей).\n• Сдано на ламинации: ${r2(laminatedPcs)} шт.\n• Сдано на фрезеровке: ${r2(millingGood)} шт.`;

    return { readyPcs, readySets, isPanel: true, formula, laminatedPcs };
  }

  const finalOp = opsList.filter((op) => l.ops[op]?.length).pop() || "";
  const rs = l.ops[finalOp] || [];
  const readyPcs = rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
  return { readyPcs, readySets: readyPcs, isPanel: false, formula: `${r2(readyPcs)} шт`, laminatedPcs: 0 };
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
      if (/панел|накладк|заготовк|мдф|скин/i.test(r.position)) {
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
    // Считаем готовность строго по активным позициям в работе, исключая 100% закрытые/готовые заказы
    const activeLines = (hideDone ? data : lines).filter((l) => l.left > 0);
    for (const l of activeLines) {
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
      hasDoneExcluded: lines.some((l) => l.left <= 0),
    };
  }, [lines, data, hideDone, ops]);

  if (!lines.length)
    return <Alert type="info" showIcon message="Нет открытых заданий на каркасы и панели под щитовые двери" />;

  const columns: GroupColumn<LineRec>[] = [
    {
      key: "name",
      title: "Позиция",
      width: 220,
      sortValue: (l) => l.source,
      render: (_, l) => {
        const cs = [...(colorsOf.get(l.key) ?? [])];
        return (
          <div style={{ lineHeight: 1.2 }}>
            <b>{l.source}</b>
            {cs.length > 0 && (
              <div title={cs.join("; ")} style={{ fontSize: 11, color: "#8c8c8c", cursor: "default" }}>
                декоров/цветов: {cs.length}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "qty",
      title: "Кол-во",
      width: 90,
      align: "right",
      sortValue: (l) => l.qty,
      render: (_, l) => {
        const isPanel = /панел|накладк|заготовк|мдф|скин/i.test(l.invoice) || /панел|накладк|заготовк|мдф|скин/i.test(l.source);
        const tip = isPanel ? `План: ${r2(l.qty)} панелей (на ${r2(Math.floor(l.qty / 2))} дверей)` : `План: ${r2(l.qty)} каркасов`;
        return (
          <b title={tip} style={{ cursor: "default" }}>
            {r2(l.qty)}
          </b>
        );
      },
      groupRender: (ls) => {
        let fQty = 0;
        let pQty = 0;
        let otherQty = 0;
        for (const l of ls) {
          if (/каркас/i.test(l.invoice) || /каркас/i.test(l.source)) fQty += l.qty;
          else if (/панел|накладк|заготовк|мдф|скин/i.test(l.invoice) || /панел|накладк|заготовк|мдф|скин/i.test(l.source)) pQty += l.qty;
          else otherQty += l.qty;
        }
        if (fQty > 0 && pQty === 0 && otherQty === 0) return <b>{r2(fQty)} шт.</b>;
        if (pQty > 0 && fQty === 0 && otherQty === 0) return <b>{r2(pQty)} шт.</b>;
        return (
          <span style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            {fQty > 0 && <span>К: <b>{r2(fQty)}</b> </span>}
            {pQty > 0 && <span>П: <b>{r2(pQty)}</b></span>}
            {otherQty > 0 && <span> Пр: {r2(otherQty)}</span>}
          </span>
        );
      },
    },
    // Колонка ПЛЁНКИ перенесена в подготовку к склейке
    {
      key: "film",
      title: "Плёнка",
      width: 104,
      align: "center",
      render: (_, l) => {
        const filmRows = Object.values(l.ops).flat().filter((r) => r.film_status || r.film);
        if (!filmRows.length) return <span style={{ color: "#bfbfbf" }}>—</span>;
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
      width: 150,
      align: "right",
      render: (_, l) => {
        const { readyPcs, readySets, isPanel, formula, laminatedPcs } = getReadyToGlue(l, ops);
        const isFrame = /каркас/i.test(l.invoice) || /каркас/i.test(l.source);
        if (readyPcs <= 0 && (!isPanel || !laminatedPcs)) return <span style={{ color: "#bfbfbf" }}>0</span>;
        const isFull = readyPcs >= l.qty - 1e-6;
        return (
          <div
            title={formula}
            style={{
              display: "inline-block",
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 500,
              cursor: "help",
              color: isFull ? "#389e0d" : readyPcs > 0 ? "#d46b08" : "#595959",
              background: isFull ? "#f6ffed" : readyPcs > 0 ? "#fff7e6" : "#f5f5f5",
              border: `1px solid ${isFull ? "#b7eb8f" : readyPcs > 0 ? "#ffd591" : "#d9d9d9"}`,
            }}
          >
            {isFrame ? (
              <span>К: <b>{r2(readyPcs)}</b>/{r2(l.qty)}</span>
            ) : (
              <span>
                П: <b>{r2(readyPcs)}</b>/{r2(l.qty)} ({readySets} дв.)
                {laminatedPcs > readyPcs && (
                  <span style={{ fontSize: 10, opacity: 0.85, marginLeft: 2 }}>[лам:{r2(laminatedPcs)}]</span>
                )}
              </span>
            )}
          </div>
        );
      },
      groupRender: (ls) => {
        let fReady = 0;
        let fPlan = 0;
        let pReady = 0;
        let pPlan = 0;
        for (const l of ls) {
          const { readyPcs, isPanel } = getReadyToGlue(l, ops);
          if (isPanel) {
            pReady += readyPcs;
            pPlan += l.qty;
          } else {
            fReady += readyPcs;
            fPlan += l.qty;
          }
        }
        const doorSets = Math.min(
          fPlan > 0 ? fReady : Infinity,
          pPlan > 0 ? Math.floor(pReady / 2) : Infinity,
        );
        const res = doorSets !== Infinity ? doorSets : 0;
        if (fPlan > 0 && pPlan === 0) {
          return <b>К: {r2(fReady)}/{r2(fPlan)}</b>;
        }
        if (pPlan > 0 && fPlan === 0) {
          return <b>П: {r2(pReady)}/{r2(pPlan)} ({Math.floor(pReady / 2)} дв.)</b>;
        }
        return (
          <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 11, lineHeight: 1.2 }}>
            <span>К: <b>{r2(fReady)}</b>/{r2(fPlan)}</span> · <span>П: <b>{r2(pReady)}</b>/{r2(pPlan)}</span>
            <Tag color={res > 0 ? "green" : "default"} style={{ marginLeft: 4, marginInlineEnd: 0, padding: "0 4px", fontSize: 10, lineHeight: "14px" }}>
              {res} компл
            </Tag>
          </div>
        );
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
              Готовность к склейке (в работе):
            </Typography.Text>
            <span style={{ fontSize: 13, marginLeft: 8 }}>
              <b>{orderSummary.doorSetsReady}</b> из <b>{orderSummary.doorSetsTotal} комплектов дверей</b>{" "}
              ({orderSummary.doorSetsTotal > 0 ? Math.round((orderSummary.doorSetsReady / orderSummary.doorSetsTotal) * 100) : 100}%)
            </span>
            {orderSummary.hasDoneExcluded && (
              <Tag color="default" style={{ marginLeft: 8, fontSize: 11 }}>
                готовые заказы исключены
              </Tag>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#595959", display: "flex", gap: 16 }}>
            <span>• Каркасы (собрано): <b>{r2(orderSummary.framesReady)}</b> из {r2(orderSummary.framesPlan)} шт</span>
            <span>• Облицовочные панели: <b>{r2(orderSummary.panelsReady)}</b> из {r2(orderSummary.panelsPlan)} шт (по 2 на дверь = {r2(Math.floor(orderSummary.panelsReady / 2))} компл.)</span>
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
        scroll={{ x: 220 + 90 + 104 + ops.length * 104 + 150 + 40, y: "calc(100vh - 360px)" }}
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
