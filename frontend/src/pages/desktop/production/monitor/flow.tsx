import { Tooltip, Typography, theme } from "antd";
import type { MonitorRow } from "../../../../api/productionMonitor";
import type { LineRec } from "./OrdersView";

const r2 = (v: number) => Math.round(v * 100) / 100;
const doneOf = (rs: MonitorRow[] = []) => rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
const planOf = (rs: MonitorRow[] = []) => rs.reduce((s, r) => s + r.plan, 0);

/** Что объединено в одну операцию программы (23.10, по листу «Щитовые все
 * запуски»: в Excel эти этапы — отдельные столбцы). */
export const OP_INCLUDES: Record<string, string> = {
  "Сборка": "молдинг, вклейка стёкол, сборка алюм. кромки",
  "Фрезеровка под замок": "врезка",
  "Сборка каркаса": "распил и шлифовка стоек, пенопласт",
};
const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е");
const includesBy = new Map(Object.entries(OP_INCLUDES).map(([k, v]) => [norm(k), v]));
export const opIncludes = (op: string) => includesBy.get(norm(op));

export interface OpFlow {
  op: string;
  plan: number;
  done: number;
  ready: number; // сделано здесь, следующий этап ещё не сделал — ждёт передачи
  inWork: number; // предыдущий этап сделал (у первого — запущено), здесь ещё нет
}

export interface Flow {
  ops: OpFlow[];
  /** по строке: op → ждёт передачи / в работе */
  byLine: Map<string, Record<string, { ready: number; inWork: number }>>;
  qty: number;
  notStarted: number; // первый этап ещё не сделал
  wip: number; // начато, но ещё не прошло последний этап
  finished: number; // прошло последний этап (упаковано)
}

/** Поток по этапам (23.10): по каждой позиции заказа — её операции по ходу
 * маршрута (у двери без кромки после сборки сразу упаковка). */
export function computeFlow(lines: LineRec[], ops: string[]): Flow {
  const acc = new Map(ops.map((op) => [op, { op, plan: 0, done: 0, ready: 0, inWork: 0 }]));
  const byLine = new Map<string, Record<string, { ready: number; inWork: number }>>();
  let qty = 0;
  let notStarted = 0;
  let wip = 0;
  let finished = 0;
  for (const l of lines) {
    // порядок — по маршруту ЭТОЙ позиции (у одних сборка до кромки, у других сборки нет)
    const seqOf = (op: string) => Math.min(...l.ops[op].map((r) => r.op_seq ?? 1000));
    const mine = ops.filter((op) => l.ops[op]?.length).sort((a, b) => seqOf(a) - seqOf(b) || ops.indexOf(a) - ops.indexOf(b));
    if (!mine.length) continue;
    const done = mine.map((op) => doneOf(l.ops[op]));
    const plan = mine.map((op) => planOf(l.ops[op]));
    const rec: Record<string, { ready: number; inWork: number }> = {};
    mine.forEach((op, k) => {
      const received = k === 0 ? plan[0] : Math.min(done[k - 1], plan[k]);
      const inWork = Math.max(0, received - done[k]);
      const ready = k < mine.length - 1 ? Math.max(0, done[k] - done[k + 1]) : 0;
      rec[op] = { ready, inWork };
      const a = acc.get(op)!;
      a.plan += plan[k];
      a.done += done[k];
      a.ready += ready;
      a.inWork += inWork;
    });
    byLine.set(l.key, rec);
    const lineQty = Math.max(plan[0], l.qty);
    qty += lineQty;
    notStarted += Math.max(0, plan[0] - done[0]);
    finished += done[done.length - 1];
    wip += Math.max(0, done[0] - done[done.length - 1]);
  }
  return { ops: ops.map((op) => acc.get(op)!), byLine, qty, notStarted, wip, finished };
}

/** Полоса «Поток по этапам» над таблицей монитора: по этапу — сколько готово и
 * ждёт передачи на следующий, сколько в работе; справа — итого. */
export function FlowStrip({
  flow,
  active,
  onPick,
  title,
}: {
  flow: Flow;
  active: string | null;
  onPick: (op: string | null) => void;
  title?: string;
}) {
  const { token } = theme.useToken();
  if (!flow.ops.length) return null;
  const card = (on: boolean) => ({
    padding: "6px 10px",
    borderRadius: 8,
    border: `1px solid ${on ? token.colorPrimary : token.colorBorderSecondary}`,
    background: on ? token.colorPrimaryBg : token.colorBgContainer,
    minWidth: 128,
    textAlign: "left" as const,
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
  });
  const num = { fontVariantNumeric: "tabular-nums" as const, fontWeight: 600, fontSize: 16 };
  return (
    <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, alignItems: "stretch" }}>
      {title && (
        <div style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: token.colorTextSecondary, textAlign: "center" }}>
          {title}
        </div>
      )}
      {flow.ops.map((f, i) => {
        const inc = opIncludes(f.op);
        const on = active === f.op;
        return (
          <button key={f.op} type="button" aria-pressed={on} style={card(on)} onClick={() => onPick(on ? null : f.op)}>
            <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
              {i + 1}. {f.op}
            </div>
            {inc && <div style={{ fontSize: 11, color: token.colorTextSecondary, maxWidth: 170 }}>вкл.: {inc}</div>}
            <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
              <Tooltip title={i < flow.ops.length - 1 ? "Сделано здесь, следующий этап ещё не сделал — готово к передаче" : "Последний этап"}>
                <div>
                  <div style={{ ...num, color: f.ready > 0 ? token.colorSuccess : token.colorTextQuaternary }}>{r2(f.ready)}</div>
                  <div style={{ fontSize: 11, color: token.colorTextSecondary }}>готово</div>
                </div>
              </Tooltip>
              <Tooltip title={i === 0 ? "Запущено, ещё не сделано" : "Предыдущий этап сделал, здесь ещё не сделано"}>
                <div>
                  <div style={{ ...num, color: f.inWork > 0 ? token.colorWarning : token.colorTextQuaternary }}>{r2(f.inWork)}</div>
                  <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{i === 0 ? "не сделано" : "в работе"}</div>
                </div>
              </Tooltip>
            </div>
            <div style={{ fontSize: 11, color: token.colorTextSecondary, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
              сделано {r2(f.done)} из {r2(f.plan)}
            </div>
          </button>
        );
      })}
      <div style={{ ...card(false), cursor: "default", background: token.colorFillQuaternary, minWidth: 150 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>Итого, шт</div>
        <div style={{ display: "grid", gridTemplateColumns: "auto auto", columnGap: 10, fontSize: 12, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
          <Typography.Text type="secondary">в работе</Typography.Text>
          <b>{r2(flow.wip)}</b>
          <Typography.Text type="secondary">не начато</Typography.Text>
          <b>{r2(flow.notStarted)}</b>
          <Typography.Text type="secondary">готово (последний этап)</Typography.Text>
          <b>{r2(flow.finished)}</b>
          <Typography.Text type="secondary">всего</Typography.Text>
          <b>{r2(flow.qty)}</b>
        </div>
      </div>
    </div>
  );
}
