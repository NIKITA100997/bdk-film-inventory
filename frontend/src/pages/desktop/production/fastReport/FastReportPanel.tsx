import { useMemo, useState } from "react";
import OverProductionTag from "../../../../components/OverProductionTag";
import { ItemChars } from "../../../../components/ItemChars";
import { UiBadge } from "../../../../components/UiBadge";
import {
  Alert,
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Radio,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import QrScanButton from "../../../../components/QrScanButton";
import { apiErrorMessage } from "../../../../utils/apiError";
import ReportModal from "../ReportModal";
import MasterQuickReportPanel from "../MasterQuickReportPanel";
import {
  PUSK_REASON,
  filmLabel,
  isFilled,
  loadPins,
  rollChoices,
  useFastReport,
  type DefectDraft,
  type Disposition,
  type FastLine,
  metersPerPanel,
} from "./useFastReport";
import type { ProductionTaskLine } from "../../../../api/production";
import { rollNo } from "../../../../utils/lotNo";
import BatchesView from "./BatchesView";

type View = "batches" | "tiles" | "table" | "legacy";

function loadView(key: string, fallback: View): View {
  try {
    return (localStorage.getItem(key) as View) || fallback;
  } catch {
    return fallback;
  }
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Быстрый отчёт мастера: «Плитки» — что на станке и на сегодня, по плёнке;
 * «Таблица» — как ежедневка, с переходом «Дальше». Один набранный отчёт на
 * оба вида; редкое (второй рулон, остаток в метрах) — «Подробно…», прежнее
 * окно отчёта. orderId — только строки этого заказа (карточка заказа). */
export default function FastReportPanel({
  area,
  orderId,
  taskId,
  onOpenTask,
  defaultView = "tiles",
  allowLegacy = false,
  title = "Отчёт о производстве",
}: {
  area: string;
  orderId?: number;
  /** Только строки этого задания (карточка задания). */
  taskId?: number;
  /** Открыть карточку задания (из панели ввода по детали). */
  onOpenTask?: (taskId: number) => void;
  defaultView?: "tiles" | "table";
  allowLegacy?: boolean;
  title?: string;
}) {
  const narrow = orderId != null || taskId != null;
  const viewKey = `fast-report-view:${narrow ? "order" : "master"}`;
  const preferredDefaultView: View =
    defaultView === "tiles" && area.toLowerCase().includes("okutka") ? "batches" : defaultView;
  const [view, setViewState] = useState<View>(() =>
    loadView(viewKey, preferredDefaultView),
  );
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(viewKey, v);
    } catch {
      /* не запоминаем */
    }
  };
  const r = useFastReport({ area, orderId, taskId });
  const isWrapping = r.profile === "wrapping" || r.requiresRoll;

  // «Мой набор» есть — открываемся на нём. Для участков без рулонов (сборка, фрезеровка, кромка)
  // по умолчанию открываем «Все позиции» ("all"), чтобы строки не скрывались.
  const [scope, setScope] = useState<"pins" | "work" | "all">(() => {
    if (narrow) return "work";
    if (loadPins(area).length) return "pins";
    return isWrapping ? "work" : "all";
  });
  const [q, setQ] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "in_work" | "done">("all");
  const [selectedStripWidth, setSelectedStripWidth] = useState<number | null>(null);
  const [selectedFilm, setSelectedFilm] = useState<string | null>(null);
  const [selectedProgram, setSelectedProgram] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [selectedThickness, setSelectedThickness] = useState<string | null>(null);
  const [open, setOpen] = useState<FastLine | null>(null);
  const [defectFor, setDefectFor] = useState<FastLine | null>(null);
  const [detailFor, setDetailFor] = useState<FastLine | null>(null);

  const orderOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const fl of r.lines) {
      if (fl.task.production_order_id) {
        map.set(
          fl.task.production_order_id,
          fl.task.production_order_name || `Заказ №${fl.task.production_order_id}`,
        );
      }
    }
    return [...map.entries()].map(([id, name]) => ({ value: id, label: name }));
  }, [r.lines]);

  const invoiceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const fl of r.lines) {
      if (fl.line.invoice_no) {
        for (const item of fl.line.invoice_no.split(",")) {
          const trimmed = item.trim();
          if (trimmed) set.add(trimmed);
        }
      }
      for (const item of fl.line.source_invoices ?? []) {
        if (item.trim()) set.add(item.trim());
      }
    }
    return [...set]
      .sort((a, b) => a.localeCompare(b, "ru", { numeric: true }))
      .map((inv) => ({ value: inv, label: `Счёт ${inv}` }));
  }, [r.lines]);

  const stripWidths = useMemo(() => {
    const set = new Set<number>();
    for (const fl of r.lines) {
      const sw = isWrapping
        ? Math.round(fl.line.strip_width_mm || 0)
        : Math.round(fl.line.width_mm || fl.doorInfo.width || 0);
      if (sw > 0) set.add(sw);
    }
    return [...set].sort((a, b) => a - b);
  }, [r.lines, isWrapping]);

  const films = useMemo(() => {
    const set = new Set<string>();
    for (const fl of r.lines) {
      const f = filmLabel(fl.line);
      if (f && f !== "без плёнки") set.add(f);
    }
    return [...set].sort();
  }, [r.lines]);

  const programs = useMemo(() => {
    const set = new Set<string>();
    for (const fl of r.lines) {
      if (fl.line.program) set.add(fl.line.program);
    }
    return [...set].sort();
  }, [r.lines]);

  const edges = useMemo(() => {
    const set = new Set<string>();
    for (const fl of r.lines) {
      const ed = fl.doorInfo.edge_label || fl.doorInfo.edge_type;
      if (ed) set.add(ed);
    }
    return [...set].sort();
  }, [r.lines]);

  const thicknesses = useMemo(() => {
    const set = new Set<string>();
    for (const fl of r.lines) {
      const thVal =
        fl.doorInfo.thickness != null
          ? String(fl.doorInfo.thickness)
          : (fl.line.thickness != null ? String(fl.line.thickness) : null);
      if (thVal) set.add(thVal);
    }
    return [...set].sort((a, b) => parseFloat(a) - parseFloat(b));
  }, [r.lines]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return r.lines
      .filter((fl) => {
        if (narrow) return true;
        if (scope === "pins") return r.pins.has(fl.line.id);
        if (scope === "work") return fl.onMachine || fl.today || isFilled(r.entryOf(fl.line));
        return true;
      })
      .filter((fl) => {
        if (selectedOrderId !== null && fl.task.production_order_id !== selectedOrderId) {
          return false;
        }
        if (selectedInvoice !== null) {
          const inv = (fl.line.invoice_no || "").toLowerCase();
          const needleInv = selectedInvoice.toLowerCase();
          const matchInv = inv.includes(needleInv) || (fl.line.source_invoices ?? []).some((si) => si.toLowerCase().includes(needleInv));
          if (!matchInv) return false;
        }
        if (statusFilter === "in_work" && fl.line.remaining_pieces <= 0 && !isFilled(r.entryOf(fl.line))) {
          return false;
        }
        if (statusFilter === "done" && fl.line.remaining_pieces > 0) {
          return false;
        }
        if (selectedStripWidth !== null) {
          const sw = isWrapping
            ? Math.round(fl.line.strip_width_mm || 0)
            : Math.round(fl.line.width_mm || fl.doorInfo.width || 0);
          if (sw !== selectedStripWidth) return false;
        }
        if (selectedFilm !== null) {
          if (filmLabel(fl.line) !== selectedFilm) return false;
        }
        if (selectedProgram !== null) {
          if (fl.line.program !== selectedProgram) return false;
        }
        if (selectedEdge !== null) {
          if (fl.doorInfo.edge_label !== selectedEdge && fl.doorInfo.edge_type !== selectedEdge) return false;
        }
        if (selectedThickness !== null) {
          const thVal =
            fl.doorInfo.thickness != null
              ? String(fl.doorInfo.thickness)
              : (fl.line.thickness != null ? String(fl.line.thickness) : null);
          if (thVal !== selectedThickness) return false;
        }
        if (!needle) return true;
        const searchPool = [
          fl.line.invoice_no ?? "",
          ...(fl.line.source_invoices ?? []),
          fl.task.production_order_name ?? "",
          fl.line.part_name ?? "",
          fl.task.name ?? "",
          fl.task.id ? `№${fl.task.id}` : "",
          filmLabel(fl.line),
          fl.doorInfo.dimensions_str ?? "",
          fl.doorInfo.series ?? "",
          fl.doorInfo.color ?? "",
          fl.line.program ? `программа ${fl.line.program}` : "",
          fl.doorInfo.edge_label ? `кромка ${fl.doorInfo.edge_label}` : "",
          fl.line.strip_width_mm ? `${fl.line.strip_width_mm}мм` : "",
          fl.line.width_mm ? `${fl.line.width_mm}мм` : "",
        ]
          .join(" ")
          .toLowerCase();
        return searchPool.includes(needle);
      })
      .sort(
        (a, b) =>
          a.groupLabel.localeCompare(b.groupLabel, "ru") ||
          (a.line.invoice_no || "").localeCompare(b.line.invoice_no || "", "ru", { numeric: true }) ||
          (a.line.part_name ?? "").localeCompare(b.line.part_name ?? "", "ru"),
      );
  }, [r, scope, q, selectedOrderId, selectedInvoice, statusFilter, selectedStripWidth, selectedFilm, selectedProgram, selectedEdge, selectedThickness, narrow, isWrapping]);

  const onSave = () => {
    const noLeft = r.filled.filter((fl) => (r.entryOf(fl.line).extra ?? []).some((x) => x.left == null));
    if (noLeft.length) {
      message.warning(`Укажите остаток на дополнительных рулонах: ${noLeft.map((fl) => fl.line.part_name).join(", ")}`);
      return;
    }
    // Рулон нужен только под штуки; «только закрыть строку» — без рулона.
    const noRoll = r.filled.filter((fl) => {
      const e = r.entryOf(fl.line);
      return r.needsRoll(fl) && (+e.good > 0 || e.pusk > 0 || e.defects.length > 0);
    });
    if (noRoll.length) {
      message.warning(
        `Выберите рулон: ${noRoll.map((fl) => fl.line.part_name).join(", ")}`,
      );
      return;
    }
    r.save.mutate(undefined, {
      onSuccess: (settled) => {
        const failed = settled.filter(
          (s): s is PromiseRejectedResult => s.status === "rejected",
        );
        const ok = settled.length - failed.length;
        if (!failed.length) message.success(`Отчёт сохранён: позиций ${ok}`);
        else {
          const detail = apiErrorMessage(failed[0].reason, "ошибка");
          message.error(
            `Сохранено ${ok} из ${settled.length}. Не сохранилось: ${detail}`,
          );
        }
      },
    });
  };

  const viewOptions = [
    { value: "batches", label: "🎯 По наладке" },
    { value: "tiles", label: "Плитки" },
    { value: "table", label: "Таблица" },
    ...(allowLegacy ? [{ value: "legacy", label: "Как раньше" }] : []),
  ];

  return (
    <Card
      title={title}
      extra={
        <Segmented
          value={view}
          onChange={(v) => setView(v as View)}
          options={viewOptions}
        />
      }
      styles={{ body: { paddingBottom: 12 } }}
    >
      {view === "legacy" ? (
        <MasterQuickReportPanel area={area} />
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap size={[8, 8]} align="center" style={{ width: "100%" }}>
            {!narrow && (
              <Segmented
                value={scope}
                onChange={(v) => setScope(v as "pins" | "work" | "all")}
                options={[
                  { value: "pins", label: `★ Мой набор ${r.pins.size}` },
                  { value: "work", label: "На станке и на сегодня" },
                  { value: "all", label: "Все позиции" },
                ]}
              />
            )}
            {!narrow && scope === "pins" && r.pins.size > 0 && (
              <Button type="link" onClick={r.clearPins}>
                Очистить набор
              </Button>
            )}
            {r.areaLines.length > 1 && (
              // своя линия — для «Ежедневки» по линиям; запоминается на планшете
              <Select
                placeholder="Моя линия"
                style={{ minWidth: 160 }}
                value={r.myLine ?? undefined}
                onChange={(v) => r.setMyLine(v ?? null)}
                allowClear
                status={r.myLine ? undefined : "warning"}
                options={r.areaLines.map((l) => ({ value: l.id, label: l.name }))}
              />
            )}
            <Input.Search
              allowClear
              placeholder="Поиск по счёту, заказу, модели, цвету..."
              style={{ minWidth: 260, flex: 1, maxWidth: 360 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {orderOptions.length > 1 && (
              <Select
                allowClear
                showSearch
                placeholder="Все заказы"
                style={{ minWidth: 180, maxWidth: 260 }}
                value={selectedOrderId ?? undefined}
                onChange={(val) => setSelectedOrderId(val ?? null)}
                options={orderOptions}
                filterOption={(input, option) =>
                  (option?.label ?? "").toLowerCase().includes(input.toLowerCase())
                }
              />
            )}
            {invoiceOptions.length > 1 && (
              <Select
                allowClear
                showSearch
                placeholder="Все счета"
                style={{ minWidth: 150, maxWidth: 200 }}
                value={selectedInvoice ?? undefined}
                onChange={(val) => setSelectedInvoice(val ?? null)}
                options={invoiceOptions}
                filterOption={(input, option) =>
                  (option?.label ?? "").toLowerCase().includes(input.toLowerCase())
                }
              />
            )}
            <Segmented
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as "all" | "in_work" | "done")}
              options={[
                { value: "all", label: "Все" },
                { value: "in_work", label: "В работе" },
                { value: "done", label: "Готовые" },
              ]}
            />
            <QrScanButton
              size="middle"
              tooltip="Сканировать QR рулона, детали или задания"
              onScan={(code) => {
                const trimmed = code.trim();
                const taskMatch = trimmed.match(/(?:task[:=\-_/]?\s*)(\d+)/i);
                const num = taskMatch ? parseInt(taskMatch[1], 10) : parseInt(trimmed, 10);
                if (!isNaN(num)) {
                  const matchRoll = r.lines.find((fl) => rollChoices(fl.line).some((rc) => rc.id === num));
                  if (matchRoll) {
                    r.setEntry(matchRoll.line, { rollId: num });
                    setOpen(matchRoll);
                    message.success(`Рулон №${num} выбран для детали ${matchRoll.line.part_name}`);
                    return;
                  }
                  const matchTask = r.lines.find((fl) => fl.task.id === num);
                  if (matchTask) {
                    setQ(String(num));
                    message.info(`Отфильтровано по заданию №${num}`);
                    return;
                  }
                }
                setQ(trimmed);
              }}
            />
          </Space>

          {/* Быстрые фильтры наладки: ЧПУ / кромка / штрипс / декор / толщина */}
          {(programs.length > 1 || edges.length > 1 || stripWidths.length > 1 || films.length > 1 || thicknesses.length > 1) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              {/* Программы ЧПУ */}
              {(r.showCnc || programs.length > 1) && programs.length > 0 && (
                <Space wrap size={[4, 4]} align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 13, marginRight: 2 }}>
                    ЧПУ:
                  </Typography.Text>
                  <Tag.CheckableTag
                    checked={selectedProgram === null}
                    onChange={() => setSelectedProgram(null)}
                    style={{ fontSize: 13, padding: "2px 8px" }}
                  >
                    Все
                  </Tag.CheckableTag>
                  {programs.map((prog) => {
                    const count = r.lines
                      .filter((fl) => fl.line.program === prog && Math.max(0, fl.line.remaining_pieces) > 0)
                      .reduce((s, fl) => s + Math.max(0, fl.line.remaining_pieces), 0);
                    return (
                      <Tag.CheckableTag
                        key={prog}
                        checked={selectedProgram === prog}
                        onChange={(checked) => setSelectedProgram(checked ? prog : null)}
                        style={{ fontSize: 13, padding: "2px 8px" }}
                      >
                        {prog}{count > 0 ? ` (${count})` : ""}
                      </Tag.CheckableTag>
                    );
                  })}
                </Space>
              )}

              {/* Кромка */}
              {(r.showEdge || edges.length > 1) && edges.length > 0 && (
                <Space wrap size={[4, 4]} align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 13, marginRight: 2 }}>
                    Кромка:
                  </Typography.Text>
                  <Tag.CheckableTag
                    checked={selectedEdge === null}
                    onChange={() => setSelectedEdge(null)}
                    style={{ fontSize: 13, padding: "2px 8px" }}
                  >
                    Все
                  </Tag.CheckableTag>
                  {edges.map((ed) => {
                    const count = r.lines
                      .filter(
                        (fl) =>
                          (fl.doorInfo.edge_label === ed || fl.doorInfo.edge_type === ed) &&
                          Math.max(0, fl.line.remaining_pieces) > 0,
                      )
                      .reduce((s, fl) => s + Math.max(0, fl.line.remaining_pieces), 0);
                    return (
                      <Tag.CheckableTag
                        key={ed}
                        checked={selectedEdge === ed}
                        onChange={(checked) => setSelectedEdge(checked ? ed : null)}
                        style={{ fontSize: 13, padding: "2px 8px" }}
                      >
                        {ed}{count > 0 ? ` (${count})` : ""}
                      </Tag.CheckableTag>
                    );
                  })}
                </Space>
              )}

              {/* Толщина заготовок */}
              {thicknesses.length > 1 && (
                <Space wrap size={[4, 4]} align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 13, marginRight: 2 }}>
                    Толщина:
                  </Typography.Text>
                  <Tag.CheckableTag
                    checked={selectedThickness === null}
                    onChange={() => setSelectedThickness(null)}
                    style={{ fontSize: 13, padding: "2px 8px" }}
                  >
                    Все
                  </Tag.CheckableTag>
                  {thicknesses.map((th) => (
                    <Tag.CheckableTag
                      key={th}
                      checked={selectedThickness === th}
                      onChange={(checked) => setSelectedThickness(checked ? th : null)}
                      style={{ fontSize: 13, padding: "2px 8px" }}
                    >
                      {th} мм
                    </Tag.CheckableTag>
                  ))}
                </Space>
              )}

              {/* Ширина штрипса для участков окутки или ширина деталей */}
              {stripWidths.length > 1 && (
                <Space wrap size={[4, 4]} align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 13, marginRight: 2 }}>
                    {isWrapping ? "Штрипс:" : "Ширина:"}
                  </Typography.Text>
                  <Tag.CheckableTag
                    checked={selectedStripWidth === null}
                    onChange={() => setSelectedStripWidth(null)}
                    style={{ fontSize: 13, padding: "2px 8px" }}
                  >
                    Все
                  </Tag.CheckableTag>
                  {stripWidths.map((sw) => {
                    const count = r.lines
                      .filter((fl) => {
                        const val = isWrapping
                          ? Math.round(fl.line.strip_width_mm || 0)
                          : Math.round(fl.line.width_mm || 0);
                        return val === sw && Math.max(0, fl.line.remaining_pieces) > 0;
                      })
                      .reduce((s, fl) => s + Math.max(0, fl.line.remaining_pieces), 0);
                    return (
                      <Tag.CheckableTag
                        key={sw}
                        checked={selectedStripWidth === sw}
                        onChange={(checked) => setSelectedStripWidth(checked ? sw : null)}
                        style={{ fontSize: 13, padding: "2px 8px" }}
                      >
                        {sw} мм{count > 0 ? ` (${count})` : ""}
                      </Tag.CheckableTag>
                    );
                  })}
                </Space>
              )}

              {/* Декор плёнки */}
              {films.length > 1 && (
                <Select
                  allowClear
                  placeholder="Фильтр по плёнке"
                  style={{ minWidth: 200 }}
                  value={selectedFilm ?? undefined}
                  onChange={(val) => setSelectedFilm(val ?? null)}
                  options={films.map((f) => ({ value: f, label: f }))}
                />
              )}
            </div>
          )}

          {r.loading ? null : shown.length === 0 ? (
            <Empty
              description={
                scope === "pins" && !narrow
                  ? "Набор пуст — отметьте ★ позиции, с которыми работаете в эту смену («Все позиции» или «На станке»)."
                  : scope === "work" && !narrow
                    ? "На станке ничего нет: рулонов не выдано и на сегодня не запланировано. Нажмите «Все позиции»."
                    : "Позиций нет"
              }
            />
          ) : view === "batches" ? (
            <BatchesView lines={shown} r={r} onOpenLine={setOpen} />
          ) : view === "tiles" ? (
            <Tiles lines={shown} r={r} onOpen={setOpen} pinnable={!narrow} />
          ) : (
            <TableView
              lines={shown}
              r={r}
              onOpen={setOpen}
              onDefect={setDefectFor}
              onDetail={setDetailFor}
              pinnable={!narrow}
            />
          )}
          <div
            style={{
              position: "sticky",
              bottom: 0,
              zIndex: 5,
              background: "inherit",
              padding: "10px 0",
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              boxShadow: r.filled.length
                ? "0 -8px 16px -12px rgba(0,0,0,.35)"
                : undefined,
            }}
          >
            <Button
              type="primary"
              size="large"
              disabled={!r.filled.length}
              loading={r.save.isPending}
              onClick={onSave}
              style={{ minWidth: 240 }}
            >
              Сохранить отчёт{r.filled.length ? ` (${r.filled.length})` : ""}
            </Button>
            {r.filled.length > 0 && (
              <Button
                size="large"
                onClick={() =>
                  r.filled.forEach((fl) => r.clearEntry(fl.line.id))
                }
              >
                Очистить набранное
              </Button>
            )}
          </div>
        </Space>
      )}

      {open && (
        <LineSheet
          fl={open}
          r={r}
          onClose={() => setOpen(null)}
          onDefect={() => setDefectFor(open)}
          onDetail={() => setDetailFor(open)}
          onOpenTask={onOpenTask}
          onNext={
            view === "table" || scope === "pins"
              ? () => {
                  const i = shown.findIndex((x) => x.line.id === open.line.id);
                  setOpen(i >= 0 && i < shown.length - 1 ? shown[i + 1] : null);
                }
              : undefined
          }
        />
      )}
      {defectFor && (
        <DefectModal
          r={r}
          fl={defectFor}
          onClose={() => setDefectFor(null)}
          onAdd={(d) =>
            r.setEntry(defectFor.line, {
              defects: [...r.entryOf(defectFor.line).defects, d],
            })
          }
        />
      )}
      {detailFor && (
        <ReportModal
          taskId={detailFor.task.id}
          line={detailFor.line}
          requiresDailyPlan={false}
          requiresRoll={r.requiresRoll && detailFor.line.material !== null}
          area={area}
          onClose={() => setDetailFor(null)}
        />
      )}
    </Card>
  );
}

type R = ReturnType<typeof useFastReport>;

function EntryBadge({ r, line }: { r: R; line: ProductionTaskLine }) {
  const e = r.entryOf(line);
  if (!isFilled(e)) return null;
  const defect = e.pusk + e.defects.reduce((s, d) => s + d.qty, 0);
  return (
    <Space size={4} wrap>
      <UiBadge color="green" style={{ marginInlineEnd: 0, fontWeight: 700 }}>
        {+e.good || 0}
        {defect ? ` · брак ${defect}` : ""}
        {e.meters != null ? ` · ${e.meters} м` : ""}
        {e.close ? " · закрыть" : ""}
      </UiBadge>
      <OverProductionTag line={line} produced={line.produced_good_pieces + (+e.good || 0)} planned={+e.good > 0} />
    </Space>
  );
}

function PinStar({ r, lineId }: { r: R; lineId: number }) {
  const on = r.pins.has(lineId);
  return (
    <button
      type="button"
      aria-label={on ? "Убрать из набора" : "В мой набор"}
      title={on ? "Убрать из набора" : "В мой набор на смену"}
      onClick={(ev) => {
        ev.stopPropagation();
        r.togglePin(lineId);
      }}
      style={{
        border: 0,
        background: "none",
        cursor: "pointer",
        fontSize: 22,
        lineHeight: 1,
        padding: "0 2px",
        color: on ? "#E0A100" : "#B8B5AE",
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

function Tiles({
  lines,
  r,
  onOpen,
  pinnable,
}: {
  lines: FastLine[];
  r: R;
  onOpen: (fl: FastLine) => void;
  pinnable: boolean;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; lines: FastLine[] }>();
    for (const fl of lines) {
      const cur = m.get(fl.groupKey) ?? { label: fl.groupLabel, lines: [] };
      cur.lines.push(fl);
      m.set(fl.groupKey, cur);
    }
    return [...m.entries()];
  }, [lines]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {groups.map(([gKey, gData]) => (
        <div key={gKey}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              {gData.label}
            </Typography.Text>
            <span style={{ fontSize: 12, color: "#6B6B68" }}>
              ({gData.lines.length} {gData.lines.length === 1 ? "строка" : "строк"})
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 10,
              marginTop: 6,
            }}
          >
            {gData.lines.map((fl) => {
              const warn = r.needsRoll(fl)
                ? " · ⚠ нет рулона"
                : (fl.line.film_warnings ?? []).length > 0
                  ? " · ⚠ плёнка"
                  : "";
              return (
                <div
                  key={fl.line.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(fl)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") onOpen(fl);
                  }}
                  style={{
                    textAlign: "left",
                    cursor: "pointer",
                    border: `2px solid ${isFilled(r.entryOf(fl.line)) ? "#1D9E75" : "#DEDEDA"}`,
                    borderRadius: 12,
                    background: "var(--ant-color-bg-container, #fff)",
                    padding: "12px 14px",
                    minHeight: 100,
                    display: "grid",
                    gap: 6,
                    font: "inherit",
                    boxShadow: isFilled(r.entryOf(fl.line)) ? "0 2px 8px rgba(29,158,117,0.18)" : undefined,
                    transition: "border-color 0.2s, box-shadow 0.2s",
                  }}
                >
                  <Space
                    style={{ justifyContent: "space-between", width: "100%" }}
                    align="start"
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>
                        {fl.line.part_name || "Деталь"}
                      </div>
                      <ItemChars chars={fl.line.item_chars} name={fl.line.part_name} showName={false} />
                    </div>
                    <Space size={4} align="center">
                      <EntryBadge r={r} line={fl.line} />
                      {pinnable && <PinStar r={r} lineId={fl.line.id} />}
                    </Space>
                  </Space>

                  {/* Технические параметры детали: Габариты, ЧПУ, Кромка, Серия, Счёт */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                    {fl.line.invoice_no && (
                      <Tag color="blue" style={{ fontWeight: 700, fontSize: 12, margin: 0 }}>
                        Счёт {fl.line.invoice_no}
                      </Tag>
                    )}
                    {r.showDimensions && fl.doorInfo.dimensions_str && (
                      <Tag color="default" style={{ fontWeight: 700, fontSize: 12, margin: 0 }}>
                        📐 {fl.doorInfo.dimensions_str}
                      </Tag>
                    )}
                    {r.showCnc && fl.line.program && (
                      <Tag color="cyan" style={{ fontWeight: 700, fontSize: 12, margin: 0 }}>
                        ЧПУ: {fl.line.program}
                      </Tag>
                    )}
                    {r.showEdge && fl.doorInfo.edge_label && (
                      <Tag color="orange" style={{ fontWeight: 600, fontSize: 12, margin: 0 }}>
                        Кромка: {fl.doorInfo.edge_label}
                      </Tag>
                    )}
                    {fl.doorInfo.series && (
                      <Tag color="blue" style={{ fontSize: 12, margin: 0 }}>
                        {fl.doorInfo.series}
                      </Tag>
                    )}
                    {r.profile === "wrapping" && fl.line.material && (
                      <span style={{ fontSize: 12, color: "#595959" }}>
                        {filmLabel(fl.line)}
                      </span>
                    )}
                  </div>
                  {fl.line.instruction && (
                    <Typography.Text type="warning" style={{ fontSize: 12, lineHeight: 1.2 }}>
                      ⚑ {fl.line.instruction}
                    </Typography.Text>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 2 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {fl.task.production_order_name ?? fl.task.name}
                      {fl.today ? " · 📅 на сегодня" : ""}
                      {warn}
                    </Typography.Text>
                    <span style={{ fontSize: 14, fontWeight: 700, color: fl.line.remaining_pieces > 0 ? "#1677ff" : "#52c41a" }}>
                      осталось {fmt(fl.line.remaining_pieces)} шт
                    </span>
                  </div>
                  <Progress
                    percent={Math.min(100, Math.round(((fl.line.produced_good_pieces + (+r.entryOf(fl.line).good || 0)) / fl.line.quantity_pieces) * 100))}
                    size="small"
                    status={fl.line.remaining_pieces <= 0 ? "success" : "active"}
                  />
                  <OverProductionTag line={fl.line} produced={fl.line.produced_good_pieces} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Space>
  );
}

/** Строки одной группы участка (08.10): одинаковые признаки, которые задал
 * участок (серия, размер, цвет, кромка…). Сначала старшие задания и строки. */
type Group = { key: string; label: string; lines: FastLine[] };

function groupLines(lines: FastLine[]): Group[] {
  const m = new Map<string, Group>();
  for (const fl of lines) {
    const key = fl.line.group_key ?? fl.groupKey ?? `line:${fl.line.id}`;
    const g = m.get(key) ?? { key, label: fl.line.group_label ?? fl.groupLabel ?? fl.line.part_name ?? "", lines: [] };
    g.lines.push(fl);
    m.set(key, g);
  }
  for (const g of m.values()) g.lines.sort((a, b) => a.task.id - b.task.id || a.line.id - b.line.id);
  return [...m.values()];
}

/** Число по группе — по её строкам: каждой до её остатка, излишек — последней. */
function distribute(g: Group, total: number): Map<number, number> {
  const out = new Map<number, number>();
  let left = total;
  g.lines.forEach((fl, i) => {
    const last = i === g.lines.length - 1;
    const take = last ? left : Math.min(left, Math.max(0, fl.line.remaining_pieces));
    out.set(fl.line.id, take);
    left -= take;
  });
  return out;
}

function GroupTableView({ lines, r, onDefect }: { lines: FastLine[]; r: R; onDefect: (fl: FastLine) => void }) {
  const groups = groupLines(lines);
  const [open, setOpen] = useState<Group | null>(null);
  const [value, setValue] = useState("");
  const cell: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #DEDEDA", verticalAlign: "middle" };
  const entered = (g: Group) => g.lines.reduce((s, fl) => s + (+r.entryOf(fl.line).good || 0), 0);
  const save = () => {
    if (!open) return;
    const parts = distribute(open, +value || 0);
    for (const fl of open.lines) r.setEntry(fl.line, { good: parts.get(fl.line.id) ? String(parts.get(fl.line.id)) : "" });
    setOpen(null);
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760, fontSize: 14 }}>
        <thead>
          <tr>
            {["Группа / Параметры", "Счета", "Заказы", "Строк", "План", "Осталось", "Годные", "Брак"].map((h) => (
              <th
                key={h}
                style={{
                  ...cell,
                  textAlign: h === "План" || h === "Осталось" ? "right" : h === "Годные" ? "center" : "left",
                  fontSize: 12,
                  color: "#6B6B68",
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const defect = g.lines.reduce((s, fl) => s + r.entryOf(fl.line).defects.reduce((x, d) => x + d.qty, 0), 0);
            const totalPlan = g.lines.reduce((s, fl) => s + fl.line.quantity_pieces, 0);
            const remaining = g.lines.reduce((s, fl) => s + Math.max(0, fl.line.remaining_pieces), 0);
            const orders = [...new Set(g.lines.map((fl) => fl.task.production_order_name ?? fl.task.name).filter(Boolean))];
            const invoices = [
              ...new Set(
                g.lines
                  .flatMap((fl) => [fl.line.invoice_no, ...(fl.line.source_invoices ?? [])])
                  .filter(Boolean)
                  .flatMap((s) => s!.split(",").map((x) => x.trim()))
                  .filter(Boolean),
              ),
            ];

            return (
              <tr key={g.key}>
                <td style={cell}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{g.label}</div>
                </td>
                <td style={cell}>
                  {invoices.length > 0 ? (
                    <Space wrap size={[2, 2]}>
                      {invoices.map((inv) => (
                        <Tag key={inv} color="blue" style={{ fontWeight: 700, fontSize: 12, margin: 0 }}>
                          {inv}
                        </Tag>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  )}
                </td>
                <td style={{ ...cell, minWidth: 120, maxWidth: 200 }}>
                  <div style={{ fontSize: 12, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={orders.join(" · ")}>
                    {orders.join(" · ") || "—"}
                  </div>
                </td>
                <td style={{ ...cell, width: 60, textAlign: "center" }}>{g.lines.length}</td>
                <td style={{ ...cell, width: 70, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(totalPlan)}</td>
                <td style={{ ...cell, width: 85, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  <b style={{ color: remaining > 0 ? "#1677ff" : "#52c41a" }}>{fmt(remaining)}</b>
                </td>
                <td style={{ ...cell, width: 90, textAlign: "center" }}>
                  <Button
                    size="large"
                    style={{
                      minWidth: 70,
                      height: 40,
                      fontWeight: 700,
                      borderColor: entered(g) > 0 ? "#52c41a" : undefined,
                      color: entered(g) > 0 ? "#389e0d" : undefined,
                      background: entered(g) > 0 ? "#f6ffed" : undefined,
                    }}
                    onClick={() => {
                      setValue(entered(g) ? String(entered(g)) : "");
                      setOpen(g);
                    }}
                  >
                    {entered(g)}
                  </Button>
                </td>
                <td style={{ ...cell, width: 80, textAlign: "center" }}>
                  <Badge count={defect} size="small">
                    <Button onClick={() => onDefect(g.lines[0])}>Брак…</Button>
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Modal
        open={!!open}
        title={open ? `${open.label} — годные` : ""}
        okText="Готово"
        cancelText="Отмена"
        onOk={save}
        onCancel={() => setOpen(null)}
        width={360}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
          Разложится по {open?.lines.length} строкам группы: каждой до её остатка, сначала старшие задания; излишек — последней.
        </Typography.Paragraph>
        <NumPad value={value} onChange={setValue} />
      </Modal>
    </div>
  );
}

function TableView(props: {
  lines: FastLine[];
  r: R;
  onOpen: (fl: FastLine) => void;
  onDefect: (fl: FastLine) => void;
  onDetail: (fl: FastLine) => void;
  pinnable: boolean;
}) {
  const hasGroups = props.lines.some((fl) => fl.line.group_key);
  const [grouped, setGrouped] = useState(true);
  if (!hasGroups) return <LinesTableView {...props} />;
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Segmented
        value={grouped ? "groups" : "lines"}
        onChange={(v) => setGrouped(v === "groups")}
        options={[
          { value: "groups", label: "По группам участка" },
          { value: "lines", label: "По строкам заказов" },
        ]}
      />
      {grouped ? <GroupTableView lines={props.lines} r={props.r} onDefect={props.onDefect} /> : <LinesTableView {...props} />}
    </Space>
  );
}

function LinesTableView({
  lines,
  r,
  onOpen,
  onDefect,
  onDetail,
  pinnable,
}: {
  lines: FastLine[];
  r: R;
  onOpen: (fl: FastLine) => void;
  onDefect: (fl: FastLine) => void;
  onDetail: (fl: FastLine) => void;
  pinnable: boolean;
}) {
  const cell: React.CSSProperties = {
    padding: "8px 10px",
    borderBottom: "1px solid #DEDEDA",
    verticalAlign: "middle",
  };

  const colFeatureTitle =
    r.profile === "milling" || r.showCnc
      ? "ЧПУ / Программа"
      : r.profile === "edgebanding" || r.showEdge
        ? "Кромка"
        : r.profile === "wrapping" || r.requiresRoll
          ? "Рулон / Штрипс"
          : "Особенности";

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          minWidth: 960,
          fontSize: 14,
        }}
      >
        <thead>
          <tr>
            {[
              pinnable ? "★" : null,
              "Счёт",
              "Заказ",
              "Серия",
              "Размер",
              "Цвет / Декор",
              colFeatureTitle,
              "План",
              "Осталось",
              "Годные",
              r.hasPusk ? "Пусковые" : null,
              "Брак",
              "",
            ]
              .filter(Boolean)
              .map((h, idx) => (
                <th
                  key={idx}
                  style={{
                    ...cell,
                    textAlign: h === "План" || h === "Осталось" ? "right" : h === "Годные" || h === "★" ? "center" : "left",
                    fontSize: 12,
                    color: "#6B6B68",
                    textTransform: "uppercase",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((fl) => {
            const e = r.entryOf(fl.line);
            const defect = e.defects.reduce((s, d) => s + d.qty, 0);
            const roll = rollChoices(fl.line).find((u) => u.id === e.rollId);
            const isLineDone = fl.line.remaining_pieces <= 0;
            const dimStr =
              fl.doorInfo.dimensions_str ||
              (fl.line.length_m > 0
                ? `${Math.round(fl.line.length_m * 1000)} × ${Math.round(fl.line.width_mm)} мм`
                : `${Math.round(fl.line.width_mm)} мм`);
            const orderName = fl.task.production_order_name ?? fl.task.name ?? `Задание №${fl.task.id}`;

            return (
              <tr key={fl.line.id} style={{ background: isFilled(e) ? "rgba(82, 196, 26, 0.05)" : undefined }}>
                {pinnable && (
                  <td style={{ ...cell, width: 36, textAlign: "center" }}>
                    <PinStar r={r} lineId={fl.line.id} />
                  </td>
                )}
                {/* Счёт */}
                <td style={{ ...cell, width: 110 }}>
                  {fl.line.invoice_no ? (
                    <Tag color="blue" style={{ fontWeight: 700, fontSize: 13, margin: 0 }}>
                      {fl.line.invoice_no}
                    </Tag>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  )}
                </td>
                {/* Заказ */}
                <td style={{ ...cell, minWidth: 120, maxWidth: 180 }}>
                  <div
                    title={orderName}
                    style={{ fontSize: 13, color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {orderName}
                  </div>
                  {fl.today && <span style={{ color: "#fa8c16", fontSize: 11, display: "block" }}>📅 на сегодня</span>}
                </td>
                {/* Серия / Модель */}
                <td style={{ ...cell, width: 90 }}>
                  {fl.doorInfo.series ? (
                    <Tag color="geekblue" style={{ fontWeight: 600, fontSize: 12, margin: 0 }}>
                      {fl.doorInfo.series}
                    </Tag>
                  ) : (
                    <span style={{ fontWeight: 500, fontSize: 13 }}>{fl.line.part_name?.split(" ")[0] || "—"}</span>
                  )}
                </td>
                {/* Размер */}
                <td style={{ ...cell, width: 130, whiteSpace: "nowrap" }}>
                  <div style={{ fontWeight: 700, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                    📐 {dimStr}
                  </div>
                </td>
                {/* Цвет / Декор */}
                <td style={{ ...cell, minWidth: 120, maxWidth: 180 }}>
                  <div
                    title={fl.doorInfo.color || (fl.line.material ? filmLabel(fl.line) : "")}
                    style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {fl.doorInfo.color || (fl.line.material ? filmLabel(fl.line) : <Typography.Text type="secondary">—</Typography.Text>)}
                  </div>
                </td>
                {/* Особенности (Кромка / ЧПУ / Рулон) */}
                <td style={{ ...cell, minWidth: 140 }}>
                  {r.profile === "milling" || r.showCnc ? (
                    <Space direction="vertical" size={2}>
                      {fl.line.program ? <UiBadge color="cyan">ЧПУ: {fl.line.program}</UiBadge> : <Typography.Text type="secondary">—</Typography.Text>}
                      {fl.line.instruction && <div style={{ fontSize: 12, color: "#d48806" }}>⚑ {fl.line.instruction}</div>}
                    </Space>
                  ) : r.profile === "edgebanding" || r.showEdge ? (
                    <Space direction="vertical" size={2}>
                      {fl.doorInfo.edge_label ? (
                        <UiBadge color="orange">Кромка: {fl.doorInfo.edge_label}</UiBadge>
                      ) : (
                        <Typography.Text type="secondary">—</Typography.Text>
                      )}
                    </Space>
                  ) : r.profile === "assembly" ? (
                    <Space direction="vertical" size={2}>
                      {fl.line.part_name && !fl.doorInfo.series && <div style={{ fontSize: 12 }}>{fl.line.part_name}</div>}
                      {fl.line.instruction && <div style={{ fontSize: 12, color: "#d48806" }}>⚑ {fl.line.instruction}</div>}
                    </Space>
                  ) : r.profile === "wrapping" || r.requiresRoll ? (
                    <div>
                      {roll ? (
                        <UiBadge color={roll.from ? "cyan" : "blue"}>
                          {rollNo(roll.id)} · {fmt(roll.left)} м{roll.from ? " · общий" : ""}
                        </UiBadge>
                      ) : r.needsRoll(fl) ? (
                        <UiBadge color="warning">нет рулона</UiBadge>
                      ) : (
                        <Typography.Text type="secondary">—</Typography.Text>
                      )}
                      {fl.line.strip_width_mm && (
                        <div style={{ fontSize: 11, color: "#8c8c8c" }}>штрипс {Math.round(fl.line.strip_width_mm)} мм</div>
                      )}
                    </div>
                  ) : (
                    fl.line.instruction ? <div style={{ fontSize: 12, color: "#d48806" }}>⚑ {fl.line.instruction}</div> : <Typography.Text type="secondary">—</Typography.Text>
                  )}
                </td>
                {/* План */}
                <td style={{ ...cell, width: 70, textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 13, color: "#555" }}>
                  {fmt(fl.line.quantity_pieces)}
                </td>
                {/* Осталось */}
                <td style={{ ...cell, width: 85, textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 14 }}>
                  <b style={{ color: isLineDone ? "#52c41a" : "#1677ff" }}>
                    {fmt(fl.line.remaining_pieces)}
                  </b>
                </td>
                {/* Годные */}
                <td style={{ ...cell, width: 85, textAlign: "center" }}>
                  <Button
                    size="large"
                    style={{
                      minWidth: 70,
                      height: 40,
                      fontWeight: 700,
                      fontSize: 15,
                      borderColor: +e.good > 0 ? "#52c41a" : undefined,
                      color: +e.good > 0 ? "#389e0d" : undefined,
                      background: +e.good > 0 ? "#f6ffed" : undefined,
                    }}
                    onClick={() => onOpen(fl)}
                  >
                    {+e.good || 0}
                  </Button>
                </td>
                {/* Пусковые */}
                {r.hasPusk && (
                  <td style={{ ...cell, width: 100, textAlign: "center" }}>
                    <Space size={4}>
                      <Button
                        size="large"
                        onClick={() =>
                          r.setEntry(fl.line, {
                            pusk: Math.max(0, e.pusk - 1),
                          })
                        }
                      >
                        −
                      </Button>
                      <Typography.Text
                        strong
                        style={{
                          minWidth: 20,
                          display: "inline-block",
                          textAlign: "center",
                        }}
                      >
                        {e.pusk}
                      </Typography.Text>
                      <Button
                        size="large"
                        onClick={() =>
                          r.setEntry(fl.line, { pusk: e.pusk + 1 })
                        }
                      >
                        +
                      </Button>
                    </Space>
                  </td>
                )}
                {/* Брак */}
                <td style={{ ...cell, width: 80, textAlign: "center" }}>
                  <Badge count={defect} size="small">
                    <Button size="middle" onClick={() => onDefect(fl)}>Брак…</Button>
                  </Badge>
                </td>
                {/* Подробно */}
                <td style={{ ...cell, width: 85, textAlign: "center" }}>
                  <Button type="link" size="small" onClick={() => onDetail(fl)}>
                    Подробно…
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NumPad({
  value,
  onChange,
  remaining,
}: {
  value: string;
  onChange: (v: string) => void;
  remaining?: number;
}) {
  const press = (k: string) => {
    if (k === "⌫") return onChange(value.slice(0, -1));
    if (k === "+1") return onChange(String((+value || 0) + 1));
    if (k === "+10") return onChange(String((+value || 0) + 10));
    if (k === "+50") return onChange(String((+value || 0) + 50));
    if (k === "all") return onChange(String(Math.max(0, remaining ?? 0)));
    if (k === "clear") return onChange("");
    if (value === "0") return onChange(k);
    return onChange(value + k);
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          fontSize: 32,
          fontWeight: 700,
          textAlign: "right",
          background: "#ECECEA",
          borderRadius: 8,
          padding: "4px 12px",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value || 0}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        <Button size="large" style={{ fontWeight: 600 }} onClick={() => press("+10")}>
          +10
        </Button>
        <Button size="large" style={{ fontWeight: 600 }} onClick={() => press("+50")}>
          +50
        </Button>
        <Button
          size="large"
          type="primary"
          ghost
          style={{ fontWeight: 600 }}
          onClick={() => press("all")}
          disabled={remaining == null || remaining <= 0}
        >
          Всё {remaining != null ? `(${remaining})` : ""}
        </Button>
        <Button size="large" danger onClick={() => press("clear")}>
          Сброс
        </Button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 6,
        }}
      >
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "+1"].map(
          (k) => (
            <Button
              key={k}
              size="large"
              style={{ height: 52, fontSize: 20, fontWeight: 700 }}
              onClick={() => {
                if (k === "+1") press("+1");
                else press(k);
              }}
            >
              {k}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}

function LineSheet({
  fl,
  r,
  onClose,
  onDefect,
  onDetail,
  onNext,
  onOpenTask,
}: {
  fl: FastLine;
  r: R;
  onClose: () => void;
  onDefect: () => void;
  onDetail: () => void;
  onNext?: () => void;
  onOpenTask?: (taskId: number) => void;
}) {
  const e = r.entryOf(fl.line);
  const rolls = rollChoices(fl.line);
  const defect = e.defects.reduce((s, d) => s + d.qty, 0);
  return (
    <Drawer
      open
      placement="bottom"
      // 16.10: на телефоне — почти весь экран, описание над цифрами (было
      // в две колонки, описание ломалось по слову в строку)
      height={typeof window !== "undefined" && window.innerWidth < 600 ? "92%" : 540}
      onClose={onClose}
      title={fl.line.part_name ?? "Позиция"}
      destroyOnHidden
    >
      <div className="fr-sheet">
        <Space orientation="vertical" size={10} style={{ width: "100%" }}>
          <Card size="small" styles={{ body: { padding: "8px 12px" } }} style={{ background: "#fafafa" }}>
            <Space wrap size={[12, 6]} align="center">
              {fl.line.invoice_no && (
                <Tag color="blue" style={{ fontWeight: 700, fontSize: 13 }}>
                  Счёт {fl.line.invoice_no}
                </Tag>
              )}
              {fl.doorInfo.dimensions_str && (
                <Typography.Text strong style={{ fontSize: 15 }}>
                  📐 {fl.doorInfo.dimensions_str}
                </Typography.Text>
              )}
              {fl.doorInfo.series && <Tag color="blue">{fl.doorInfo.series}</Tag>}
              {fl.line.program && <Tag color="cyan">ЧПУ: {fl.line.program}</Tag>}
              {fl.doorInfo.edge_label && <Tag color="orange">Кромка: {fl.doorInfo.edge_label}</Tag>}
              {fl.line.material && <Tag color="purple">{filmLabel(fl.line)}</Tag>}
            </Space>
            {fl.line.instruction && (
              <div style={{ marginTop: 4, color: "#d48806", fontSize: 12 }}>
                ⚑ {fl.line.instruction}
              </div>
            )}
          </Card>
          <Typography.Text type="secondary">
            {onOpenTask ? (
              <a onClick={() => onOpenTask(fl.task.id)}>
                Задание №{fl.task.id} «{fl.task.name ?? fl.task.production_order_name}» →
              </a>
            ) : (
              (fl.task.production_order_name ?? fl.task.name)
            )}{" "}
            · план{" "}
            {fmt(fl.line.quantity_pieces)}, сделано{" "}
            {fmt(fl.line.produced_good_pieces)}, осталось{" "}
            {fmt(fl.line.remaining_pieces)}
            {fl.line.material ? ` · ${filmLabel(fl.line)}` : ""}
          </Typography.Text>
          <OverProductionTag line={fl.line} produced={fl.line.produced_good_pieces + (+e.good || 0)} planned={+e.good > 0} />
          {(fl.line.film_warnings ?? []).map((w) => (
            <Alert key={w} type="warning" showIcon message={w} />
          ))}
          {!r.requiresRoll && fl.line.material !== null && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "4px 0" }}>
              <Typography.Text type="secondary">
                Штрипс {fl.line.strip_width_mm || fl.line.width_mm} мм:
              </Typography.Text>
              {fl.line.area_strip_stock_m != null && fl.line.area_strip_stock_m > 0 ? (
                <UiBadge color="success">
                  В цехе {fl.line.area_strip_stock_m} м ({fl.line.area_strip_count ?? 1} шт.) · FIFO
                </UiBadge>
              ) : (
                <UiBadge color="warning">Нет штрипса в цехе</UiBadge>
              )}
              {fl.line.film_deficit_m != null && fl.line.film_deficit_m > 0 && (
                <UiBadge color="error">Дефицит: -{fl.line.film_deficit_m} м</UiBadge>
              )}
            </div>
          )}
          {r.requiresRoll && fl.line.material !== null && (
            <Space orientation="vertical" size={6} style={{ width: "100%" }}>
              <Space wrap>
                <Typography.Text>Рулон:</Typography.Text>
                {rolls.length === 0 ? (
                  <Typography.Text type="warning">
                    не выдан — «Подробно…» или выдайте рулон на «Выдаче участку»
                  </Typography.Text>
                ) : (
                  rolls
                    .filter((u) => !(e.extra ?? []).some((x) => x.id === u.id))
                    .map((u) => (
                      <Button
                        key={u.id}
                        type={e.rollId === u.id ? "primary" : "default"}
                        onClick={() => r.setEntry(fl.line, { rollId: u.id })}
                      >
                        {rollNo(u.id)} · {u.width_mm} мм · {fmt(u.left)} м
                        {u.from ? ` · с «${u.from}»` : ""}
                      </Button>
                    ))
                )}
              </Space>
              {(() => {
                // «+ ещё рулон»: шли с двух рулонов (другая сторона детали) — без «Подробно…».
                const free = rolls.filter((u) => u.id !== e.rollId && !(e.extra ?? []).some((x) => x.id === u.id));
                if (!e.rollId || !free.length) return null;
                return (
                  <Space wrap>
                    <Typography.Text type="secondary">+ ещё рулон:</Typography.Text>
                    {free.map((u) => (
                      <Button
                        key={u.id}
                        size="small"
                        onClick={() => r.setEntry(fl.line, { extra: [...(e.extra ?? []), { id: u.id, left: 0 }] })}
                      >
                        {rollNo(u.id)} · {fmt(u.left)} м
                      </Button>
                    ))}
                  </Space>
                );
              })()}
              {(e.extra ?? []).map((x) => {
                const u = rolls.find((c) => c.id === x.id);
                return (
                  <Space key={x.id} wrap>
                    <Typography.Text>
                      + {rollNo(x.id)}: осталось на рулоне, м
                    </Typography.Text>
                    {/* Обычно доп. штрипс уходит в ноль, остаток — на одном (09.10). */}
                    <Button size="large" type={x.left === 0 ? "primary" : "default"}
                      onClick={() => r.setEntry(fl.line, { extra: (e.extra ?? []).map((y) => (y.id === x.id ? { ...y, left: 0 } : y)) })}>
                      в ноль
                    </Button>
                    <InputNumber
                      min={0}
                      max={u?.left}
                      inputMode="decimal"
                      size="large"
                      style={{ width: 120 }}
                      value={x.left ?? undefined}
                      placeholder={u ? `было ${fmt(u.left)}` : ""}
                      onChange={(v) =>
                        r.setEntry(fl.line, {
                          extra: (e.extra ?? []).map((y) => (y.id === x.id ? { ...y, left: v ?? null } : y)),
                        })
                      }
                    />
                    {u && x.left != null && (
                      <Typography.Text type="secondary">
                        расход {fmt(Math.max(0, u.left - x.left))} м{x.left === 0 ? " · штрипс закроется как израсходованный" : ""}
                      </Typography.Text>
                    )}
                    <Button
                      type="link"
                      onClick={() => r.setEntry(fl.line, { extra: (e.extra ?? []).filter((y) => y.id !== x.id) })}
                    >
                      убрать
                    </Button>
                  </Space>
                );
              })}
            </Space>
          )}
          {r.hasPusk && (
            <Space wrap>
              <Typography.Text>Пусковые / наладка:</Typography.Text>
              {[1, 2, 3].map((n) => (
                <Button
                  key={n}
                  size="large"
                  danger={e.pusk === n}
                  type={e.pusk === n ? "primary" : "default"}
                  onClick={() =>
                    r.setEntry(fl.line, { pusk: e.pusk === n ? 0 : n })
                  }
                >
                  {n}
                </Button>
              ))}
              {/* своё количество — когда пусковых больше трёх (05.10) */}
              <InputNumber
                min={0}
                precision={0}
                inputMode="numeric"
                size="large"
                placeholder="своё"
                style={{ width: 100 }}
                status={e.pusk > 3 ? "warning" : undefined}
                value={e.pusk > 3 ? e.pusk : null}
                onChange={(v) => r.setEntry(fl.line, { pusk: v ?? 0 })}
              />
            </Space>
          )}
          {r.filmByMeters && fl.line.material !== null && (
            <Space wrap>
              <Typography.Text>Израсходовано плёнки, м:</Typography.Text>
              <InputNumber
                min={0}
                inputMode="decimal"
                size="large"
                style={{ width: 120 }}
                value={e.meters ?? undefined}
                onChange={(v) => r.setEntry(fl.line, { meters: v ?? null })}
              />
              {e.meters != null &&
                (() => {
                  const all = defect + e.pusk;
                  const m = metersPerPanel(e.meters, +e.good || 0, all);
                  return (
                    <Typography.Text type="secondary">
                      {m.perGood != null ? `≈ ${fmt(m.perGood)} м на годную панель` : ""}
                      {m.perAll != null && all > 0 ? ` · ${fmt(m.perAll)} м на панель с браком` : ""}
                    </Typography.Text>
                  );
                })()}
            </Space>
          )}
          <Space wrap>
            <Badge count={defect} size="small">
              <Button size="large" onClick={onDefect}>
                Брак…
              </Button>
            </Badge>
            <Button size="large" onClick={onDetail}>
              Подробно…
            </Button>
          </Space>
          <Button
            size="large"
            type={e.close ? "primary" : "default"}
            danger={!!e.close}
            onClick={() => r.setEntry(fl.line, { close: !e.close })}
          >
            {e.close ? "✓ Строка будет закрыта" : "Строка сделана полностью — закрыть"}
          </Button>
          {e.close && (
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              После сохранения строка уйдёт из отчёта
              {fl.line.remaining_pieces - (+e.good || 0) > 0
                ? ` — остаток ${fmt(fl.line.remaining_pieces - (+e.good || 0))} шт делать не нужно`
                : ""}
              . Вернуть может начальник цеха.
            </Typography.Text>
          )}
          <Space wrap>
            <Button
              type="primary"
              size="large"
              style={{ background: "#1D9E75" }}
              onClick={onClose}
            >
              Готово · годных {+e.good || 0}
            </Button>
            {onNext && (
              <Button size="large" onClick={onNext}>
                Дальше ↓
              </Button>
            )}
          </Space>
        </Space>
        <NumPad
          value={e.good}
          onChange={(v) => r.setEntry(fl.line, { good: v })}
          remaining={fl.line.remaining_pieces}
        />
      </div>
    </Drawer>
  );
}

export function DefectModal({
  r,
  fl,
  onClose,
  onAdd,
}: {
  r: R;
  fl: FastLine;
  onClose: () => void;
  onAdd: (d: DefectDraft) => void;
}) {
  const [form] = Form.useForm<{
    reason: string;
    qty: number;
    disposition: Disposition;
  }>();
  const current = r.entryOf(fl.line).defects;
  return (
    <Modal
      open
      title={`Брак — ${fl.line.part_name ?? ""}`}
      onCancel={onClose}
      okText="Добавить"
      cancelText="Закрыть"
      onOk={() => form.submit()}
      destroyOnHidden
    >
      {current.length > 0 && (
        <Space orientation="vertical" style={{ width: "100%", marginBottom: 12 }}>
          {current.map((d, i) => (
            <Space key={i}>
              <UiBadge>
                {r.reasons.find((x) => x.code === d.reason)?.name ?? d.reason}:{" "}
                {d.qty} шт
              </UiBadge>
              <Button
                size="small"
                type="link"
                onClick={() =>
                  r.setEntry(fl.line, {
                    defects: current.filter((_, j) => j !== i),
                  })
                }
              >
                убрать
              </Button>
            </Space>
          ))}
        </Space>
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ disposition: "spisat" }}
        onFinish={(v) => {
          onAdd({
            reason: v.reason,
            qty: v.qty,
            disposition: v.disposition ?? "spisat",
          });
          form.resetFields();
          onClose();
        }}
      >
        <Form.Item
          name="reason"
          label="Причина"
          rules={[{ required: true, message: "Выберите причину" }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            options={r.reasons
              .filter((x) => !r.hasPusk || x.code !== PUSK_REASON)
              .map((x) => ({ value: x.code, label: x.name }))}
          />
        </Form.Item>
        <Form.Item
          name="qty"
          label="Количество, шт"
          rules={[{ required: true, message: "Сколько штук" }]}
        >
          <InputNumber min={1} style={{ width: "100%" }} size="large" />
        </Form.Item>
        {r.requiresRoll && (
          <Form.Item name="disposition" label="Что с браком">
            <Radio.Group
              optionType="button"
              options={[
                { label: "Списать", value: "spisat" },
                { label: "В переработку", value: "pererabotka" },
                { label: "Снять плёнку (под «Ламис»)", value: "snyat" },
              ]}
            />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
