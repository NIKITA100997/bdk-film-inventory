import { useMemo, useState } from "react";
import { Button, Card, Popover, Space, Tag, Tooltip, Typography, theme } from "antd";
import {
  ApartmentOutlined,
  ArrowRightOutlined,
  CloseOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { MonitorRow } from "../../../../api/productionMonitor";
import type { LineRec } from "./OrdersView";

const r2 = (v: number) => Math.round(v * 100) / 100;
const dm = (s: string | null | undefined) => (s ? s.slice(0, 10).split("-").reverse().slice(0, 2).join(".") : "");

interface OrderFlowMapProps {
  orderId: number;
  orderName: string;
  shipDate?: string | null;
  launchDate?: string | null;
  lines: LineRec[];
  allRows: MonitorRow[];
  ops: string[];
  onOpenTask?: (id: number) => void;
  onClose: () => void;
}

interface StepNode {
  key: string;
  title: string;
  subTitle?: string;
  plan: number;
  done: number;
  defect: number;
  inWork: number;
  waitingNext: number; // сдано здесь, следующий этап ещё не обработал (задел)
  waitingPrev: number; // предыдущий сдал, здесь ещё не обработано (очередь на входе)
  isDone: boolean;
  rows: MonitorRow[];
  kind: "pf_frame" | "pf_panel" | "pf_set" | "op" | "finish";
}

export default function OrderFlowMap({
  orderId,
  orderName,
  shipDate,
  launchDate,
  lines: _lines,
  allRows,
  ops,
  onOpenTask,
  onClose,
}: OrderFlowMapProps) {
  const { token } = theme.useToken();
  const [activeStep, setActiveStep] = useState<string | null>(null);

  // Все строки текущего заказа
  const orderRows = useMemo(() => allRows.filter((r) => r.order_id === orderId), [allRows, orderId]);
  const pfRows = useMemo(() => orderRows.filter((r) => r.part_id != null), [orderRows]);
  const gpRows = useMemo(() => orderRows.filter((r) => r.part_id == null && r.order_line_id != null), [orderRows]);

  // Расчёт движения полуфабрикатов и дверных операций
  const {
    framesNode,
    panelsNode,
    setNode,
    opNodes,
    finishNode,
    totalDoors,
    finishedDoors,
    leftDoors,
    bottlenecks,
  } = useMemo(() => {
    // 1. Каркасы
    const fRows = pfRows.filter((r) => /каркас/i.test(r.position));
    const fPlan = fRows.reduce((s, r) => s + r.plan, 0);
    const fDone = fRows.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
    const fDefect = fRows.reduce((s, r) => s + (r.defect ?? 0), 0);

    // 2. Панели
    const pRows = pfRows.filter((r) => /панел|накладк|заготовк|мдф|скин/i.test(r.position));
    const pPlan = pRows.reduce((s, r) => s + r.plan, 0);
    const pDone = pRows.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
    const pDefect = pRows.reduce((s, r) => s + (r.defect ?? 0), 0);

    // Панели по переделам (ламинация vs фрезеровка)
    const lamRows = pRows.filter(
      (r) =>
        r.area === "uchastok_membranno_vakuumnykh_pressov" ||
        r.area === "fabrika" ||
        /ламинац|окутк/i.test(r.operation || ""),
    );
    const lamDone = lamRows.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
    const millRows = pRows.filter(
      (r) => r.area === "frezerovka_laminirovannykh_paneley" || /фрезер/i.test(r.operation || ""),
    );
    const millDone = millRows.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);

    // 3. Комплекты П/Ф под щитовые двери
    const setsPlan = Math.min(
      fPlan > 0 ? fPlan : Infinity,
      pPlan > 0 ? Math.floor(pPlan / 2) : Infinity,
    );
    const setsReady = Math.min(
      fPlan > 0 ? fDone : Infinity,
      pPlan > 0 ? Math.floor(pDone / 2) : Infinity,
    );

    // 4. Дверные операции маршрута (Склейка -> Форматка -> Кромка -> ...)
    // Берем только операции, реально присутствующие в этом заказе
    const activeOps = ops.filter((op) => gpRows.some((r) => (r.operation || r.area) === op));

    // Склейка — первая операция двери
    const skleykaOp = activeOps[0];
    const skleykaRows = skleykaOp ? gpRows.filter((r) => (r.operation || r.area) === skleykaOp) : [];
    const skleykaDone = skleykaRows.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);

    const setsWaitingGlue = setsReady !== Infinity ? Math.max(0, setsReady - skleykaDone) : 0;

    const fn: StepNode = {
      key: "pf_frames",
      title: "1А. Каркасы",
      subTitle: "Столярка",
      plan: fPlan,
      done: fDone,
      defect: fDefect,
      inWork: Math.max(0, fPlan - fDone),
      waitingNext: fDone,
      waitingPrev: 0,
      isDone: fPlan > 0 && fDone >= fPlan,
      rows: fRows,
      kind: "pf_frame",
    };

    const pn: StepNode = {
      key: "pf_panels",
      title: "1Б. Панели",
      subTitle: millRows.length > 0 ? `Лам: ${r2(lamDone)} · Фрез: ${r2(millDone)}` : "Прессы/Ламинация",
      plan: pPlan,
      done: pDone,
      defect: pDefect,
      inWork: Math.max(0, pPlan - pDone),
      waitingNext: pDone,
      waitingPrev: 0,
      isDone: pPlan > 0 && pDone >= pPlan,
      rows: pRows,
      kind: "pf_panel",
    };

    const sn: StepNode = {
      key: "pf_sets",
      title: "Комплекты П/Ф",
      subTitle: "1 каркас + 2 панели",
      plan: setsPlan !== Infinity ? setsPlan : 0,
      done: setsReady !== Infinity ? setsReady : 0,
      defect: 0,
      inWork: setsWaitingGlue,
      waitingNext: setsWaitingGlue,
      waitingPrev: 0,
      isDone: setsPlan !== Infinity && setsReady >= setsPlan,
      rows: pfRows,
      kind: "pf_set",
    };

    // Строим цепочку дверных операций
    const opList: StepNode[] = [];
    let prevDone = setsReady !== Infinity ? setsReady : (skleykaRows[0]?.plan ?? 0);

    activeOps.forEach((op, idx) => {
      const rs = gpRows.filter((r) => (r.operation || r.area) === op);
      const plan = rs.reduce((s, r) => s + r.plan, 0);
      const done = rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
      const defect = rs.reduce((s, r) => s + (r.defect ?? 0), 0);

      // Сколько поступило с предыдущего этапа
      const received = idx === 0 ? (setsReady !== Infinity ? setsReady : plan) : prevDone;
      // В очереди на обработку на этом станке
      const waitingPrev = Math.max(0, received - done);

      // Сколько сделано здесь и ожидает следующий этап
      let nextDone = 0;
      if (idx < activeOps.length - 1) {
        const nextOp = activeOps[idx + 1];
        const nextRs = gpRows.filter((r) => (r.operation || r.area) === nextOp);
        nextDone = nextRs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0);
      }
      const waitingNext = idx < activeOps.length - 1 ? Math.max(0, done - nextDone) : 0;

      opList.push({
        key: `op_${op}`,
        title: `${idx + 1}. ${op}`,
        subTitle: rs[0]?.task_name ?? rs[0]?.area,
        plan,
        done,
        defect,
        inWork: Math.max(0, plan - done),
        waitingNext,
        waitingPrev,
        isDone: plan > 0 && done >= plan,
        rows: rs,
        kind: "op",
      });

      prevDone = done;
    });

    const lastOpNode = opList[opList.length - 1];
    const totalPlan = opList[0]?.plan ?? (setsPlan !== Infinity ? setsPlan : 0);
    const finished = lastOpNode?.done ?? 0;
    const left = Math.max(0, totalPlan - finished);

    const fin: StepNode = {
      key: "finish",
      title: "Склад ГП",
      subTitle: "Готово к отгрузке",
      plan: totalPlan,
      done: finished,
      defect: 0,
      inWork: left,
      waitingNext: 0,
      waitingPrev: 0,
      isDone: totalPlan > 0 && finished >= totalPlan,
      rows: lastOpNode?.rows ?? [],
      kind: "finish",
    };

    // Выявляем узкие места (где скопился наибольший межоперационный задел)
    const bn: { from: string; to: string; count: number }[] = [];
    if (setsWaitingGlue > 5) {
      bn.push({ from: "Комплекты П/Ф", to: activeOps[0] ?? "Склейка", count: setsWaitingGlue });
    }
    for (let i = 0; i < opList.length - 1; i++) {
      if (opList[i].waitingNext > 5) {
        bn.push({ from: opList[i].title, to: opList[i + 1].title, count: opList[i].waitingNext });
      }
    }

    return {
      framesNode: fn,
      panelsNode: pn,
      setNode: sn,
      opNodes: opList,
      finishNode: fin,
      totalDoors: totalPlan,
      finishedDoors: finished,
      leftDoors: left,
      bottlenecks: bn,
    };
  }, [orderRows, pfRows, gpRows, ops]);

  const hasPf = framesNode.plan > 0 || panelsNode.plan > 0;
  const pctFinished = totalDoors > 0 ? Math.round((finishedDoors / totalDoors) * 100) : 0;

  return (
    <Card
      size="small"
      style={{
        margin: "6px 0 10px 0",
        background: "#f9fbff",
        border: "1px solid #bae0ff",
        borderRadius: 8,
        boxShadow: "0 2px 8px rgba(0, 40, 100, 0.06)",
      }}
      bodyStyle={{ padding: "10px 14px" }}
    >
      {/* Заголовок карты заказа */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 10,
          borderBottom: "1px solid #e6f1ff",
          paddingBottom: 8,
        }}
      >
        <Space size={8} wrap>
          <ApartmentOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
          <Typography.Text strong style={{ fontSize: 13, color: token.colorTextHeading }}>
            Интерактивная карта движения заказа №{orderId} «{orderName}»
          </Typography.Text>
          {shipDate && (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              отгрузка {dm(shipDate)}
            </Tag>
          )}
          {launchDate && (
            <Tag style={{ marginInlineEnd: 0 }}>
              запуск {dm(launchDate)}
            </Tag>
          )}
        </Space>

        <Space size={12} wrap>
          <div style={{ fontSize: 12 }}>
            Всего: <b>{r2(totalDoors)} шт</b> · Готово:{" "}
            <b style={{ color: finishedDoors >= totalDoors ? token.colorSuccess : token.colorPrimary }}>
              {r2(finishedDoors)} шт
            </b>{" "}
            ({pctFinished}%) · Осталось:{" "}
            <b style={{ color: leftDoors > 0 ? token.colorWarningText : token.colorSuccess }}>
              {r2(leftDoors)} шт
            </b>
          </div>
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            onClick={onClose}
            title="Свернуть карту движения"
            aria-label="Закрыть"
          />
        </Space>
      </div>

      {/* Оповещение об узких местах (заторах) */}
      {bottlenecks.length > 0 && (
        <div style={{ marginBottom: 10, padding: "4px 8px", background: "#fffbe6", border: "1px solid #ffe58f", borderRadius: 6, fontSize: 11 }}>
          <Space size={6} wrap>
            <WarningOutlined style={{ color: "#faad14" }} />
            <Typography.Text strong style={{ color: "#d48806" }}>
              Внимание, очередь заготовок:
            </Typography.Text>
            {bottlenecks.map((b, i) => (
              <Tag key={i} color="warning" style={{ marginInlineEnd: 4 }}>
                {b.from} ➔ {b.to}: <b>{r2(b.count)} шт</b> в очереди
              </Tag>
            ))}
          </Space>
        </div>
      )}

      {/* Горизонтальная интерактивная схема потока */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", overflowX: "auto", paddingBottom: 6 }}>
        {/* ВЕТВЬ 1: ПОЛУФАБРИКАТЫ (если это щитовые двери) */}
        {hasPf && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "#ffffff",
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px dashed #91caff",
            }}
          >
            {/* Параллельные ветки: Каркасы и Панели */}
            <div style={{ display: "grid", gap: 6 }}>
              <RenderNode
                node={framesNode}
                active={activeStep === framesNode.key}
                onSelect={() => setActiveStep(activeStep === framesNode.key ? null : framesNode.key)}
                onOpenTask={onOpenTask}
              />
              <RenderNode
                node={panelsNode}
                active={activeStep === panelsNode.key}
                onSelect={() => setActiveStep(activeStep === panelsNode.key ? null : panelsNode.key)}
                onOpenTask={onOpenTask}
              />
            </div>

            {/* Схождение в узел комплектации */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
              <ArrowRightOutlined style={{ color: "#1677ff", fontSize: 13 }} />
            </div>

            <RenderNode
              node={setNode}
              active={activeStep === setNode.key}
              onSelect={() => setActiveStep(activeStep === setNode.key ? null : setNode.key)}
              onOpenTask={onOpenTask}
              highlight={setNode.waitingNext > 0}
            />

            <div style={{ display: "flex", alignItems: "center" }}>
              <FlowArrow count={setNode.waitingNext} label="компл. к склейке" />
            </div>
          </div>
        )}

        {/* ВЕТВЬ 2: ДВЕРНОЙ КОНВЕЙЕР (Склейка -> Форматка -> Кромка -> Врезка -> Сборка -> Упаковка) */}
        {opNodes.map((node, i) => (
          <div key={node.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <RenderNode
              node={node}
              active={activeStep === node.key}
              onSelect={() => setActiveStep(activeStep === node.key ? null : node.key)}
              onOpenTask={onOpenTask}
            />
            {i < opNodes.length - 1 && (
              <FlowArrow count={node.waitingNext} label="в очереди" />
            )}
          </div>
        ))}

        {/* УЗЕЛ 3: ФИНАЛЬНЫЙ СКЛАД ГП */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ArrowRightOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
          <RenderNode
            node={finishNode}
            active={activeStep === finishNode.key}
            onSelect={() => setActiveStep(activeStep === finishNode.key ? null : finishNode.key)}
            onOpenTask={onOpenTask}
          />
        </div>
      </div>
    </Card>
  );
}

/** Соединительная стрелка с бейджем задела/очереди */
function FlowArrow({ count, label }: { count: number; label: string }) {
  const isClogged = count > 5;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 42 }}>
      {count > 0 ? (
        <Tooltip title={`Межоперационный задел: ${r2(count)} шт. ожидает следующий этап (${label})`}>
          <Tag
            color={isClogged ? "orange" : "blue"}
            style={{
              margin: 0,
              padding: "0 4px",
              fontSize: 10,
              lineHeight: "14px",
              cursor: "help",
              fontWeight: 600,
            }}
          >
            ➔ {r2(count)}
          </Tag>
        </Tooltip>
      ) : null}
      <ArrowRightOutlined
        style={{
          color: count > 0 ? (isClogged ? "#fa8c16" : "#1677ff") : "#d9d9d9",
          fontSize: 13,
          marginTop: 2,
        }}
      />
    </div>
  );
}

/** Отдельный интерактивный узел потока */
function RenderNode({
  node,
  active,
  onSelect,
  onOpenTask,
  highlight = false,
}: {
  node: StepNode;
  active: boolean;
  onSelect: () => void;
  onOpenTask?: (id: number) => void;
  highlight?: boolean;
}) {
  const { token } = theme.useToken();
  const pct = node.plan > 0 ? Math.round((node.done / node.plan) * 100) : 100;
  const isFull = node.isDone;

  const nodeColor = isFull
    ? "#f6ffed"
    : highlight
    ? "#fff7e6"
    : node.done > 0
    ? "#e6f4ff"
    : "#ffffff";

  const borderColor = isFull
    ? "#b7eb8f"
    : highlight
    ? "#ffd591"
    : active
    ? token.colorPrimary
    : node.done > 0
    ? "#91caff"
    : "#d9d9d9";

  const content = (
    <div style={{ maxWidth: 360 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
        {node.title} {node.subTitle ? `(${node.subTitle})` : ""}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.4 }}>
        <div>• План: <b>{r2(node.plan)} шт</b></div>
        <div>
          • Сдано: <b style={{ color: isFull ? token.colorSuccess : "#fa8c16" }}>{r2(node.done)} шт</b> ({pct}%)
        </div>
        {node.inWork > 0 && <div>• В работе / осталось: <b>{r2(node.inWork)} шт</b></div>}
        {node.defect > 0 && <div style={{ color: "#ff4d4f" }}>• Брак: <b>{r2(node.defect)} шт</b></div>}
        {node.waitingNext > 0 && (
          <div style={{ color: "#52c41a", marginTop: 4 }}>
            • Задел к след. этапу: <b>{r2(node.waitingNext)} шт</b> (ждёт приёмки)
          </div>
        )}
      </div>

      {node.rows.length > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px solid #f0f0f0", paddingTop: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#8c8c8c", marginBottom: 4 }}>
            Позиции на этом этапе ({node.rows.length}):
          </div>
          <div style={{ maxHeight: 160, overflowY: "auto", fontSize: 11, display: "grid", gap: 3 }}>
            {node.rows.map((r, i) => {
              const rem = r.closed ? 0 : Math.max(0, r.plan - r.good);
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <span style={{ wordBreak: "break-word" }}>{r.position}</span>
                  <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    <b>{r2(r.good)}</b>/{r2(r.plan)}
                    {rem > 0 ? ` (ост. ${r2(rem)})` : " ✓"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {node.rows[0]?.task_id && onOpenTask && (
        <div style={{ marginTop: 8, textAlign: "right" }}>
          <Button size="small" type="link" onClick={() => onOpenTask(node.rows[0].task_id)}>
            Открыть задание №{node.rows[0].task_id} →
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <Popover content={content} trigger="click" placement="bottom">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        style={{
          minWidth: 120,
          maxWidth: 160,
          background: nodeColor,
          border: `1px solid ${borderColor}`,
          borderRadius: 6,
          padding: "6px 8px",
          cursor: "pointer",
          transition: "all 0.15s ease",
          boxShadow: active ? "0 0 0 2px rgba(22, 119, 255, 0.2)" : undefined,
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
          <span style={{ fontWeight: 600, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {node.title}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: isFull ? token.colorSuccess : node.done > 0 ? "#fa8c16" : token.colorTextSecondary,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {pct}%
          </span>
        </div>

        {node.subTitle && (
          <div style={{ fontSize: 10, color: token.colorTextSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {node.subTitle}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "baseline", gap: 3, marginTop: 3 }}>
          <span
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: isFull ? token.colorSuccess : node.done > 0 ? "#d46b08" : token.colorTextTertiary,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {r2(node.done)}
          </span>
          <span style={{ fontSize: 11, color: token.colorTextSecondary, fontVariantNumeric: "tabular-nums" }}>
            / {r2(node.plan)}
          </span>
        </div>

        {/* Нижний индикатор задела или очереди */}
        <div style={{ marginTop: 2, display: "flex", justifyContent: "space-between", fontSize: 10 }}>
          {node.waitingNext > 0 ? (
            <span style={{ color: token.colorSuccess }}>ждёт: {r2(node.waitingNext)}</span>
          ) : isFull ? (
            <span style={{ color: token.colorSuccess }}>закрыто ✓</span>
          ) : (
            <span style={{ color: token.colorTextQuaternary }}>ост: {r2(node.inWork)}</span>
          )}
        </div>
      </div>
    </Popover>
  );
}
