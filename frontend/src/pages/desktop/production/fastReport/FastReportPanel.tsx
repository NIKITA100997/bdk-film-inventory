import { useMemo, useState } from "react";
import OverProductionTag from "../../../../components/OverProductionTag";
import { ItemChars } from "../../../../components/ItemChars";
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
  Radio,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { isAxiosError } from "axios";
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

type View = "tiles" | "table" | "legacy";

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
  const [view, setViewState] = useState<View>(() =>
    loadView(viewKey, defaultView),
  );
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(viewKey, v);
    } catch {
      /* не запоминаем */
    }
  };
  // «Мой набор» есть — открываемся на нём (отмеченное мастером на смену).
  const [scope, setScope] = useState<"pins" | "work" | "all">(() => (!narrow && loadPins(area).length ? "pins" : "work"));
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<FastLine | null>(null);
  const [defectFor, setDefectFor] = useState<FastLine | null>(null);
  const [detailFor, setDetailFor] = useState<FastLine | null>(null);
  const r = useFastReport({ area, orderId, taskId });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return r.lines
      .filter(
        (fl) =>
          narrow ||
          scope === "all" ||
          (scope === "pins" ? r.pins.has(fl.line.id) : false) ||
          (scope === "work" && fl.onMachine) ||
          (scope === "work" && fl.today) ||
          (scope !== "pins" && isFilled(r.entryOf(fl.line))),
      )
      .filter(
        (fl) =>
          !needle ||
          `${fl.line.part_name ?? ""} ${fl.task.name ?? ""} ${filmLabel(fl.line)}`
            .toLowerCase()
            .includes(needle),
      )
      .sort(
        (a, b) =>
          filmLabel(a.line).localeCompare(filmLabel(b.line), "ru") ||
          (a.line.part_name ?? "").localeCompare(b.line.part_name ?? "", "ru"),
      );
  }, [r, scope, q, narrow]);

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
          const e = failed[0].reason;
          const detail =
            isAxiosError(e) && typeof e.response?.data?.detail === "string"
              ? e.response.data.detail
              : "ошибка";
          message.error(
            `Сохранено ${ok} из ${settled.length}. Не сохранилось: ${detail}`,
          );
        }
      },
    });
  };

  const viewOptions = [
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
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
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
                style={{ minWidth: 180 }}
                value={r.myLine ?? undefined}
                onChange={(v) => r.setMyLine(v ?? null)}
                allowClear
                status={r.myLine ? undefined : "warning"}
                options={r.areaLines.map((l) => ({ value: l.id, label: l.name }))}
              />
            )}
            <Input.Search
              allowClear
              placeholder="Деталь, заказ или плёнка"
              style={{ width: 280 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </Space>
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
      <Tag color="green" style={{ marginInlineEnd: 0, fontWeight: 700 }}>
        {+e.good || 0}
        {defect ? ` · брак ${defect}` : ""}
        {e.meters != null ? ` · ${e.meters} м` : ""}
        {e.close ? " · закрыть" : ""}
      </Tag>
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
    const m = new Map<string, FastLine[]>();
    for (const fl of lines)
      m.set(filmLabel(fl.line), [...(m.get(filmLabel(fl.line)) ?? []), fl]);
    return [...m.entries()];
  }, [lines]);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {groups.map(([film, fls]) => (
        <div key={film}>
          <Typography.Text strong>{film}</Typography.Text>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
              gap: 8,
              marginTop: 6,
            }}
          >
            {fls.map((fl) => {
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
                    border: `1px solid ${isFilled(r.entryOf(fl.line)) ? "#1D9E75" : "#DEDEDA"}`,
                    borderRadius: 10,
                    background: "var(--ant-color-bg-container, #fff)",
                    padding: "10px 12px",
                    minHeight: 76,
                    display: "grid",
                    gap: 4,
                    font: "inherit",
                  }}
                >
                  <Space
                    style={{ justifyContent: "space-between", width: "100%" }}
                    align="start"
                  >
                    <Space direction="vertical" size={0}>
                      <ItemChars chars={fl.line.item_chars} name={fl.line.part_name} showName={false} />
                      {fl.line.program && <Typography.Text style={{ fontSize: 12 }}>программа {fl.line.program}</Typography.Text>}
                      {fl.line.instruction && <Typography.Text type="warning" style={{ fontSize: 12 }}>⚑ {fl.line.instruction}</Typography.Text>}
                    </Space>
                    <Space size={4} align="center">
                      <EntryBadge r={r} line={fl.line} />
                      {pinnable && <PinStar r={r} lineId={fl.line.id} />}
                    </Space>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {fl.task.production_order_name ?? fl.task.name} · осталось{" "}
                    {fmt(fl.line.remaining_pieces)}
                    {fl.today ? " · на сегодня" : ""}
                    {warn}
                  </Typography.Text>
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
    const key = fl.line.group_key ?? `line:${fl.line.id}`;
    const g = m.get(key) ?? { key, label: fl.line.group_label ?? fl.line.part_name ?? "", lines: [] };
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
  const cell: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #DEDEDA", verticalAlign: "middle" };
  const entered = (g: Group) => g.lines.reduce((s, fl) => s + (+r.entryOf(fl.line).good || 0), 0);
  const save = () => {
    if (!open) return;
    const parts = distribute(open, +value || 0);
    for (const fl of open.lines) r.setEntry(fl.line, { good: parts.get(fl.line.id) ? String(parts.get(fl.line.id)) : "" });
    setOpen(null);
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640, fontSize: 14 }}>
        <thead>
          <tr>
            {["Группа", "Строк", "Осталось", "Годные", "Брак"].map((h) => (
              <th key={h} style={{ ...cell, textAlign: "left", fontSize: 12, color: "#6B6B68", textTransform: "uppercase" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const defect = g.lines.reduce((s, fl) => s + r.entryOf(fl.line).defects.reduce((x, d) => x + d.qty, 0), 0);
            const remaining = g.lines.reduce((s, fl) => s + Math.max(0, fl.line.remaining_pieces), 0);
            const orders = [...new Set(g.lines.map((fl) => fl.task.production_order_name ?? fl.task.name))];
            return (
              <tr key={g.key}>
                <td style={cell}>
                  <b>{g.label}</b>
                  <div style={{ fontSize: 12, color: "#6B6B68" }}>{orders.join(" · ")}</div>
                </td>
                <td style={cell}>{g.lines.length}</td>
                <td style={cell}>{fmt(remaining)}</td>
                <td style={cell}>
                  <Button
                    size="large"
                    style={{ minWidth: 80, fontWeight: 700 }}
                    onClick={() => {
                      setValue(entered(g) ? String(entered(g)) : "");
                      setOpen(g);
                    }}
                  >
                    {entered(g)}
                  </Button>
                </td>
                <td style={cell}>
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
    <Space direction="vertical" style={{ width: "100%" }}>
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
    padding: "6px 8px",
    borderBottom: "1px solid #DEDEDA",
    verticalAlign: "middle",
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          minWidth: 760,
          fontSize: 14,
        }}
      >
        <thead>
          <tr>
            {[
              "Позиция",
              "Плёнка / рулон",
              "Годные",
              r.hasPusk ? "Пусковые" : null,
              "Брак",
              "",
            ]
              .filter(Boolean)
              .map((h) => (
                <th
                  key={h as string}
                  style={{
                    ...cell,
                    textAlign: "left",
                    fontSize: 12,
                    color: "#6B6B68",
                    textTransform: "uppercase",
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
            return (
              <tr key={fl.line.id}>
                <td style={cell}>
                  {pinnable && <PinStar r={r} lineId={fl.line.id} />}
                  <ItemChars chars={fl.line.item_chars} name={fl.line.part_name} showName={false} />
                  <div style={{ fontSize: 12, color: "#6B6B68" }}>
                    {fl.task.production_order_name ?? fl.task.name} · осталось{" "}
                    {fmt(fl.line.remaining_pieces)}
                  </div>
                  <OverProductionTag line={fl.line} produced={fl.line.produced_good_pieces} />
                </td>
                <td style={cell}>
                  <div style={{ fontSize: 13 }}>{filmLabel(fl.line)}</div>
                  {roll ? (
                    <Tag color={roll.from ? "cyan" : "blue"}>
                      {rollNo(roll.id)} · {fmt(roll.left)} м
                      {roll.from ? " · общий" : ""}
                    </Tag>
                  ) : r.needsRoll(fl) ? (
                    <Tag color="warning">нет рулона</Tag>
                  ) : null}
                </td>
                <td style={cell}>
                  <Button
                    size="large"
                    style={{ minWidth: 80, fontWeight: 700 }}
                    onClick={() => onOpen(fl)}
                  >
                    {+e.good || 0}
                  </Button>
                </td>
                {r.hasPusk && (
                  <td style={cell}>
                    {fl.line.material === null ? (
                      "—"
                    ) : (
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
                    )}
                  </td>
                )}
                <td style={cell}>
                  <Badge count={defect} size="small">
                    <Button onClick={() => onDefect(fl)}>Брак…</Button>
                  </Badge>
                </td>
                <td style={cell}>
                  <Button type="link" onClick={() => onDetail(fl)}>
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
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const press = (k: string) => {
    if (k === "⌫") onChange(value.slice(0, -1));
    else if (k === "+10") onChange(String((+value || 0) + 10));
    else onChange((value === "0" ? "" : value) + k);
  };
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        style={{
          fontSize: 32,
          fontWeight: 700,
          textAlign: "right",
          background: "#ECECEA",
          borderRadius: 8,
          padding: "2px 12px",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value || 0}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 6,
        }}
      >
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "+10"].map(
          (k) => (
            <Button
              key={k}
              size="large"
              style={{ height: 52, fontSize: 20, fontWeight: 700 }}
              onClick={() => press(k)}
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
      height={540}
      onClose={onClose}
      title={fl.line.part_name ?? "Позиция"}
      destroyOnHidden
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 280px",
          gap: 16,
        }}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
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
            {fmt(fl.line.remaining_pieces)} · {filmLabel(fl.line)}
          </Typography.Text>
          <OverProductionTag line={fl.line} produced={fl.line.produced_good_pieces + (+e.good || 0)} planned={+e.good > 0} />
          {(fl.line.film_warnings ?? []).map((w) => (
            <Alert key={w} type="warning" showIcon message={w} />
          ))}
          {r.requiresRoll && fl.line.material !== null && (
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
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
          {r.hasPusk && fl.line.material !== null && (
            <Space wrap>
              <Typography.Text>Пусковые:</Typography.Text>
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
        />
      </div>
    </Drawer>
  );
}

function DefectModal({
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
        <Space direction="vertical" style={{ width: "100%", marginBottom: 12 }}>
          {current.map((d, i) => (
            <Space key={i}>
              <Tag>
                {r.reasons.find((x) => x.code === d.reason)?.name ?? d.reason}:{" "}
                {d.qty} шт
              </Tag>
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
