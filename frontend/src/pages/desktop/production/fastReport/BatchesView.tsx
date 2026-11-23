import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Collapse,
  Empty,
  InputNumber,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import {
  defaultRoll,
  filmLabel,
  isFilled,
  rollChoices,
  type FastLine,
  type useFastReport,
} from "./useFastReport";
import { DefectModal } from "./FastReportPanel";

const { Text } = Typography;

type R = ReturnType<typeof useFastReport>;

export interface SetupBatch {
  key: string;
  badgeType: "wrapping" | "milling" | "edgebanding" | "assembly" | "universal";
  title: string;
  subtitle?: string;
  dimensions?: string;
  stripWidth?: number;
  film?: string;
  program?: string;
  edge?: string;
  series?: string;
  filler?: string;
  lines: FastLine[];
  totalPlan: number;
  totalProduced: number;
  totalRemaining: number;
  tasks: Array<{ id: number; name: string }>;
  orders: string[];
  invoices: string[];
}

export default function BatchesView({
  lines,
  r,
  onOpenLine,
}: {
  lines: FastLine[];
  r: R;
  onOpenLine?: (fl: FastLine) => void;
}) {
  const [defectTarget, setDefectTarget] = useState<FastLine | null>(null);

  // Адаптивная группировка наладок в зависимости от технологического профиля участка:
  // - wrapping: [Ширина штрипса] + [Декор плёнки]
  // - milling: [Программа ЧПУ] / [Толщина МДФ]
  // - edgebanding: [Кромка: тип, декор, стороны]
  // - assembly: [Серия] + [Наполнитель] + [Габариты]
  // - universal / packaging: [Габариты / Название]
  const isWrapping = r.profile === "wrapping" || r.requiresRoll;
  const isMilling = r.profile === "milling";
  const isEdgebanding = r.profile === "edgebanding";
  const isAssembly = r.profile === "assembly";

  const batches = useMemo(() => {
    const map = new Map<string, SetupBatch>();
    for (const fl of lines) {
      let key = "";
      let badgeType: SetupBatch["badgeType"] = "universal";
      let title = "";
      let subtitle: string | undefined = undefined;
      let stripWidth: number | undefined = undefined;
      let film: string | undefined = undefined;
      let program: string | undefined = undefined;
      let edge: string | undefined = undefined;
      let series: string | undefined = undefined;
      let filler: string | undefined = undefined;
      const dimensions = fl.doorInfo.dimensions_str || undefined;

      if (isWrapping) {
        badgeType = "wrapping";
        stripWidth = Math.round(fl.line.strip_width_mm || 0);
        film = filmLabel(fl.line);
        key = `${stripWidth}|${film}`;
        title = `📏 Штрипс ${stripWidth} мм`;
        subtitle = film !== "без плёнки" ? film : undefined;
      } else if (isMilling) {
        badgeType = "milling";
        if (fl.line.program) {
          program = fl.line.program;
          key = `prog:${program}`;
          title = `⚙ ЧПУ: ${program}`;
          if (fl.doorInfo.thickness) {
            subtitle = `МДФ ${fl.doorInfo.thickness} мм`;
          }
        } else if (fl.doorInfo.thickness) {
          key = `th:${fl.doorInfo.thickness}`;
          title = `МДФ ${fl.doorInfo.thickness} мм · Без программы`;
        } else if (dimensions) {
          key = `dim:${dimensions}`;
          title = `📐 ${dimensions}`;
        } else {
          key = `part:${fl.line.part_name || "manual"}`;
          title = fl.line.part_name || "Детали без программы";
        }
      } else if (isEdgebanding) {
        badgeType = "edgebanding";
        if (fl.doorInfo.edge_label) {
          edge = fl.doorInfo.edge_label;
          key = `edge:${edge}`;
          title = `🎗 ${edge}`;
        } else if (fl.doorInfo.edge_type) {
          const el = `${fl.doorInfo.edge_type} ${fl.doorInfo.edge_color ?? ""}`.trim();
          edge = el;
          key = `edge:${el}`;
          title = `🎗 Кромка: ${el}`;
        } else {
          key = "edge:none";
          title = "Без кромки (внутренние детали)";
        }
      } else if (isAssembly) {
        badgeType = "assembly";
        series = fl.doorInfo.series ?? undefined;
        filler = fl.doorInfo.filler ?? undefined;
        const sPart = series ? `Серия ${series}` : "";
        const fPart = filler ? filler : "";
        const dimPart = dimensions || (fl.doorInfo.width ? `${fl.doorInfo.width} мм` : "");
        const labelParts = [sPart, fPart, dimPart].filter(Boolean);
        const label = labelParts.length > 0 ? labelParts.join(" · ") : (fl.line.part_name || "Детали");
        key = `asm:${label}`;
        title = `🔨 ${label}`;
      } else {
        badgeType = "universal";
        const label = dimensions || fl.line.part_name || "Позиции";
        key = `univ:${label}`;
        title = `📦 ${label}`;
      }

      let b = map.get(key);
      if (!b) {
        b = {
          key,
          badgeType,
          title,
          subtitle,
          dimensions,
          stripWidth,
          film,
          program,
          edge,
          series,
          filler,
          lines: [],
          totalPlan: 0,
          totalProduced: 0,
          totalRemaining: 0,
          tasks: [],
          orders: [],
          invoices: [],
        };
        map.set(key, b);
      }
      b.lines.push(fl);
      b.totalPlan += fl.line.quantity_pieces;
      b.totalProduced += fl.line.produced_good_pieces;
      b.totalRemaining += Math.max(0, fl.line.remaining_pieces);

      if (!b.tasks.some((t) => t.id === fl.task.id)) {
        b.tasks.push({ id: fl.task.id, name: fl.task.name || `Задание №${fl.task.id}` });
      }
      const ordName = fl.task.production_order_name;
      if (ordName && !b.orders.includes(ordName)) {
        b.orders.push(ordName);
      }
      const invs = [fl.line.invoice_no, ...(fl.line.source_invoices ?? [])].filter(Boolean);
      for (const item of invs) {
        for (const piece of item!.split(",")) {
          const trimmed = piece.trim();
          if (trimmed && !b.invoices.includes(trimmed)) {
            b.invoices.push(trimmed);
          }
        }
      }
    }

    // Внутри каждой наладки сортируем строки по FIFO (раньше задание — раньше исполняется)
    for (const b of map.values()) {
      b.lines.sort((x, y) => x.task.id - y.task.id || x.line.id - y.line.id);
    }

    // Сортировка наладок: сначала те, где больше всего осталось сделать
    return [...map.values()].sort((a, b) => b.totalRemaining - a.totalRemaining);
  }, [lines, isWrapping, isMilling, isEdgebanding, isAssembly]);

  if (!batches.length) {
    return <Empty description="Нет открытых позиций для текущего фильтра" />;
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {batches.map((batch) => (
        <BatchCard
          key={batch.key}
          batch={batch}
          r={r}
          onDefect={(fl) => setDefectTarget(fl)}
          onOpenLine={onOpenLine}
        />
      ))}

      {defectTarget && (
        <DefectModal
          r={r}
          fl={defectTarget}
          onClose={() => setDefectTarget(null)}
          onAdd={(d) => {
            r.setEntry(defectTarget.line, {
              defects: [...r.entryOf(defectTarget.line).defects, d],
            });
            message.success(`Зафиксирован брак (${d.qty} шт) для ${defectTarget.line.part_name}`);
          }}
        />
      )}
    </Space>
  );
}

function BatchCard({
  batch,
  r,
  onDefect,
  onOpenLine,
}: {
  batch: SetupBatch;
  r: R;
  onDefect: (fl: FastLine) => void;
  onOpenLine?: (fl: FastLine) => void;
}) {
  const [goodInput, setGoodInput] = useState<number | null>(null);
  const isWrapping = r.profile === "wrapping" || r.requiresRoll;

  // Все доступные рулоны для этой плёнки на участке (только для участков окутки)
  const availableRolls = useMemo(() => {
    if (!isWrapping) return [];
    const firstLine = batch.lines[0]?.line;
    if (!firstLine) return [];
    return rollChoices(firstLine);
  }, [batch.lines, isWrapping]);

  const [selectedRoll, setSelectedRoll] = useState<number | null>(() => {
    if (!isWrapping) return null;
    const firstLine = batch.lines[0]?.line;
    return firstLine ? defaultRoll(firstLine) : null;
  });

  // Сколько уже набрано в черновике отчёта по этой группе
  const currentDraftGood = batch.lines.reduce((s, fl) => s + (+r.entryOf(fl.line).good || 0), 0);
  const currentDraftDefects = batch.lines.reduce(
    (s, fl) => s + r.entryOf(fl.line).defects.reduce((acc, d) => acc + d.qty, 0),
    0,
  );

  const percent = Math.min(
    100,
    Math.round(((batch.totalProduced + currentDraftGood) / (batch.totalPlan || 1)) * 100),
  );

  // Распределение ввода по строкам группы по FIFO
  const applyBatch = (qty: number) => {
    if (qty <= 0) return;
    let leftToAssign = qty;

    for (let i = 0; i < batch.lines.length; i++) {
      const fl = batch.lines[i];
      const isLast = i === batch.lines.length - 1;
      const rem = Math.max(0, fl.line.remaining_pieces);

      // Каждой строке до её остатка; излишек уходит в последнюю строку
      const take = isLast ? leftToAssign : Math.min(leftToAssign, rem);
      leftToAssign -= take;

      if (take > 0 || isLast) {
        r.setEntry(fl.line, {
          good: String(take),
          rollId: isWrapping ? (selectedRoll ?? defaultRoll(fl.line)) : null,
        });
      }
    }

    message.success(`Набрано ${qty} шт на партию (распределено по строкам заданий)`);
    setGoodInput(null);
  };

  return (
    <Card
      size="small"
      style={{
        borderRadius: 12,
        border: currentDraftGood > 0 ? "2px solid #52c41a" : "1px solid #d9d9d9",
        boxShadow: currentDraftGood > 0 ? "0 2px 10px rgba(82, 196, 26, 0.15)" : undefined,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
        <Space wrap align="center">
          <Tag
            color={
              batch.badgeType === "wrapping"
                ? "blue"
                : batch.badgeType === "milling"
                  ? "cyan"
                  : batch.badgeType === "edgebanding"
                    ? "orange"
                    : batch.badgeType === "assembly"
                      ? "blue"
                      : "default"
            }
            style={{ fontSize: 14, padding: "3px 10px", fontWeight: 700 }}
          >
            {batch.title}
          </Tag>
          {batch.subtitle && (
            <Tag
              color={batch.badgeType === "wrapping" ? "geekblue" : "default"}
              style={{ fontSize: 13, padding: "2px 8px" }}
            >
              {batch.badgeType === "wrapping" ? `🎬 ${batch.subtitle}` : batch.subtitle}
            </Tag>
          )}
          {batch.badgeType !== "wrapping" && batch.dimensions && (
            <Tag color="default" style={{ fontSize: 13, padding: "2px 8px", fontWeight: 600 }}>
              📐 {batch.dimensions}
            </Tag>
          )}
          {batch.filler && (
            <Tag color="purple" style={{ fontSize: 13, padding: "2px 8px", fontWeight: 600 }}>
              🛡 {batch.filler}
            </Tag>
          )}
          <Text type="secondary" style={{ fontSize: 13 }}>
            📋 Заданий: {batch.tasks.length} (строк: {batch.lines.length})
          </Text>
          {batch.invoices.length > 0 && (
            <Space wrap size={[2, 2]}>
              {batch.invoices.slice(0, 4).map((inv) => (
                <Tag key={inv} color="blue" style={{ fontWeight: 700, fontSize: 12, margin: 0 }}>
                  Счёт {inv}
                </Tag>
              ))}
              {batch.invoices.length > 4 && (
                <Tag style={{ fontSize: 11, margin: 0 }}>+{batch.invoices.length - 4}</Tag>
              )}
            </Space>
          )}
          {batch.orders.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              · {batch.orders.slice(0, 2).join(", ")}
              {batch.orders.length > 2 ? ` (+${batch.orders.length - 2})` : ""}
            </Text>
          )}
        </Space>

        <Space align="center">
          <span style={{ fontSize: 14, fontWeight: 700, color: batch.totalRemaining > 0 ? "#1677ff" : "#52c41a" }}>
            Осталось: {batch.totalRemaining} шт
          </span>
          {currentDraftGood > 0 && (
            <Tag color="success" style={{ fontWeight: 700 }}>
              + {currentDraftGood} в отчёте
            </Tag>
          )}
          {currentDraftDefects > 0 && (
            <Tag color="error" style={{ fontWeight: 700 }}>
              брак {currentDraftDefects}
            </Tag>
          )}
        </Space>
      </div>

      <div style={{ margin: "10px 0 12px 0" }}>
        <Progress
          percent={percent}
          size={["100%", 10]}
          status={batch.totalRemaining <= 0 ? "success" : "active"}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#8c8c8c", marginTop: 2 }}>
          <span>Сделано: {batch.totalProduced + currentDraftGood} шт</span>
          <span>План: {batch.totalPlan} шт</span>
        </div>
      </div>

      {/* Панель быстрого действия наладкой */}
      <div
        style={{
          background: "#fafafa",
          padding: "10px 12px",
          borderRadius: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <Space wrap align="center">
          {isWrapping && availableRolls.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: 500 }}>Штрипс:</Text>
              <Select
                size="middle"
                style={{ minWidth: 230, minHeight: 40 }}
                placeholder="Выберите штрипс"
                value={selectedRoll ?? undefined}
                onChange={(val) => setSelectedRoll(val)}
                options={availableRolls.map((roll) => ({
                  value: roll.id,
                  label: `Штрипс №${roll.id} (${roll.width_mm} мм, ост. ${Math.round(roll.left)} м)${roll.from ? ` · ${roll.from}` : ""}`,
                }))}
              />
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <InputNumber
              size="large"
              min={0}
              placeholder="Годных, шт"
              style={{ width: 140, height: 42, fontSize: 16 }}
              value={goodInput}
              onChange={(val) => setGoodInput(val)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && goodInput && goodInput > 0) {
                  applyBatch(goodInput);
                }
              }}
            />
            <Button
              type="primary"
              size="large"
              icon={<ThunderboltOutlined />}
              disabled={!goodInput || goodInput <= 0}
              onClick={() => goodInput && applyBatch(goodInput)}
              style={{ minHeight: 44, fontWeight: 600, fontSize: 14 }}
            >
              Записать партию
            </Button>
            <Button
              size="large"
              style={{ minHeight: 44, fontSize: 14 }}
              onClick={() => {
                if (batch.totalRemaining > 0) {
                  applyBatch(batch.totalRemaining);
                }
              }}
            >
              Сдать всё ({batch.totalRemaining} шт)
            </Button>
          </div>
        </Space>

        <Space size="middle">
          <Button
            danger
            size="large"
            style={{ minHeight: 44, fontSize: 14 }}
            onClick={() => {
              if (batch.lines.length > 0) {
                onDefect(batch.lines[0]);
              }
            }}
          >
            Брак…
          </Button>
          {currentDraftGood > 0 && (
            <Button
              type="link"
              size="large"
              style={{ minHeight: 44, fontSize: 14 }}
              onClick={() => {
                batch.lines.forEach((fl) => r.clearEntry(fl.line.id));
              }}
            >
              Сбросить
            </Button>
          )}
        </Space>
      </div>

      {/* Список входящих строк заданий (разворачиваемый) */}
      <Collapse
        ghost
        size="small"
        style={{ marginTop: 8 }}
        items={[
          {
            key: "details",
            label: (
              <div style={{ padding: "6px 0", cursor: "pointer", display: "flex", alignItems: "center" }}>
                <Text type="secondary" style={{ fontSize: 13, fontWeight: 500 }}>
                  Состав партии ({batch.lines.length} строк заданий) — нажмите, чтобы раскрыть
                </Text>
              </div>
            ),
            children: (
              <div style={{ display: "grid", gap: 8 }}>
                {batch.lines.map((fl) => {
                  const lineEntry = r.entryOf(fl.line);
                  const isLineDone = fl.line.remaining_pieces <= 0;
                  return (
                    <div
                      key={fl.line.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "8px 12px",
                        background: isFilled(lineEntry) ? "#f6ffed" : "#fff",
                        border: "1px solid #f0f0f0",
                        borderRadius: 8,
                        fontSize: 13,
                        minHeight: 44,
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <Space wrap>
                        {fl.line.invoice_no && (
                          <Tag color="blue" style={{ fontWeight: 700, fontSize: 12, margin: 0 }}>
                            Счёт {fl.line.invoice_no}
                          </Tag>
                        )}
                        <Text strong>{fl.line.part_name || "Деталь"}</Text>
                        {r.showDimensions && fl.doorInfo.dimensions_str && (
                          <Tag color="default" style={{ fontWeight: 600, fontSize: 11, margin: 0 }}>
                            📐 {fl.doorInfo.dimensions_str}
                          </Tag>
                        )}
                        {r.showCnc && fl.line.program && (
                          <Tag color="cyan" style={{ fontWeight: 600, fontSize: 11, margin: 0 }}>
                            ЧПУ: {fl.line.program}
                          </Tag>
                        )}
                        {r.showEdge && fl.doorInfo.edge_label && (
                          <Tag color="orange" style={{ fontWeight: 600, fontSize: 11, margin: 0 }}>
                            Кромка: {fl.doorInfo.edge_label}
                          </Tag>
                        )}
                        {fl.doorInfo.filler && (
                          <Tag color="purple" style={{ fontWeight: 600, fontSize: 11, margin: 0 }}>
                            🛡 {fl.doorInfo.filler}
                          </Tag>
                        )}
                        {fl.doorInfo.series && (
                          <Tag color="blue" style={{ fontWeight: 600, fontSize: 11, margin: 0 }}>
                            {fl.doorInfo.series}
                          </Tag>
                        )}
                        <Text type="secondary">
                          Задание №{fl.task.id}
                          {fl.task.production_order_name ? ` · Заказ ${fl.task.production_order_name}` : ""}
                        </Text>
                        {isWrapping && fl.line.length_m > 0 && (
                          <Text type="secondary">
                            ({fl.line.length_m} м/шт)
                          </Text>
                        )}
                      </Space>

                      <Space>
                        <span>
                          План: <b>{fl.line.quantity_pieces}</b> · Сделано: <b>{fl.line.produced_good_pieces}</b> · Осталось:{" "}
                          <b style={{ color: isLineDone ? "#52c41a" : "#1677ff" }}>{fl.line.remaining_pieces}</b>
                        </span>
                        {isFilled(lineEntry) && (
                          <Tag color="green">
                            +{lineEntry.good} шт
                          </Tag>
                        )}
                        {onOpenLine && (
                          <Button
                            size="middle"
                            type="link"
                            style={{ minHeight: 38, paddingInline: 12, fontWeight: 500 }}
                            onClick={() => onOpenLine(fl)}
                          >
                            Подробнее
                          </Button>
                        )}
                      </Space>
                    </div>
                  );
                })}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}
