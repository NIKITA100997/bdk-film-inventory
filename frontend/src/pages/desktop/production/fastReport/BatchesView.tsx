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
  stripWidth: number;
  film: string;
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

  // Группировка строк по связке [Ширина штрипса] + [Декор плёнки] (для окутки)
  // или по [Размерам] (для сборки / остальных участков)
  const isWrapping = r.profile === "wrapping" || r.requiresRoll;
  const batches = useMemo(() => {
    const map = new Map<string, SetupBatch>();
    for (const fl of lines) {
      const sw = isWrapping
        ? Math.round(fl.line.strip_width_mm || 0)
        : Math.round(fl.line.width_mm || fl.doorInfo.width || 0);
      const film = filmLabel(fl.line);
      const dim = fl.doorInfo.dimensions_str || `${sw} мм`;
      const key = isWrapping ? `${sw}|${film}` : dim;
      let b = map.get(key);
      if (!b) {
        b = {
          key,
          stripWidth: sw,
          film,
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
  }, [lines]);

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

  // Все доступные рулоны для этой плёнки на участке
  const availableRolls = useMemo(() => {
    const firstLine = batch.lines[0]?.line;
    if (!firstLine) return [];
    return rollChoices(firstLine);
  }, [batch.lines]);

  const [selectedRoll, setSelectedRoll] = useState<number | null>(() => {
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
          rollId: selectedRoll ?? defaultRoll(fl.line),
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
          <Tag color="blue" style={{ fontSize: 14, padding: "3px 10px", fontWeight: 700 }}>
            {r.profile === "wrapping" || r.requiresRoll
              ? `📏 Штрипс ${batch.stripWidth} мм`
              : `📐 ${batch.lines[0]?.doorInfo.dimensions_str || `${batch.stripWidth} мм`}`}
          </Tag>
          {(r.profile === "wrapping" || r.requiresRoll) && batch.film !== "без плёнки" && (
            <Tag color="geekblue" style={{ fontSize: 14, padding: "3px 10px" }}>
              🎬 {batch.film}
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
          {availableRolls.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 12 }}>Штрипс на станке:</Text>
              <Select
                size="middle"
                style={{ minWidth: 220 }}
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

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <InputNumber
              size="middle"
              min={0}
              placeholder="Годных, шт"
              style={{ width: 130 }}
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
              icon={<ThunderboltOutlined />}
              disabled={!goodInput || goodInput <= 0}
              onClick={() => goodInput && applyBatch(goodInput)}
            >
              Записать партию
            </Button>
            <Button
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

        <Space>
          <Button
            danger
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
              <Text type="secondary" style={{ fontSize: 12 }}>
                Состав партии ({batch.lines.length} строк заданий) — нажмите, чтобы раскрыть
              </Text>
            ),
            children: (
              <div style={{ display: "grid", gap: 6 }}>
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
                        padding: "6px 8px",
                        background: isFilled(lineEntry) ? "#f6ffed" : "#fff",
                        border: "1px solid #f0f0f0",
                        borderRadius: 6,
                        fontSize: 13,
                      }}
                    >
                      <Space wrap>
                        {fl.line.invoice_no && (
                          <Tag color="blue" style={{ fontWeight: 700, fontSize: 12, margin: 0 }}>
                            Счёт {fl.line.invoice_no}
                          </Tag>
                        )}
                        <Text strong>{fl.line.part_name || "Деталь"}</Text>
                        <Text type="secondary">
                          Задание №{fl.task.id}
                          {fl.task.production_order_name ? ` · Заказ ${fl.task.production_order_name}` : ""}
                        </Text>
                        <Text type="secondary">
                          ({fl.line.length_m} м/шт)
                        </Text>
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
                          <Button size="small" type="link" onClick={() => onOpenLine(fl)}>
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
