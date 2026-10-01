import { useMemo, useState } from "react";
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
  rollChoices,
  useFastReport,
  type DefectDraft,
  type Disposition,
  type FastLine,
} from "./useFastReport";
import type { ProductionTaskLine } from "../../../../api/production";

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
  const [scope, setScope] = useState<"work" | "all">("work");
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
          scope === "all" ||
          narrow ||
          fl.onMachine ||
          fl.today ||
          isFilled(r.entryOf(fl.line)),
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
    const noRoll = r.filled.filter((fl) => r.needsRoll(fl));
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
                onChange={(v) => setScope(v as "work" | "all")}
                options={[
                  { value: "work", label: "На станке и на сегодня" },
                  { value: "all", label: "Все позиции" },
                ]}
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
                scope === "work" && !narrow
                  ? "На станке ничего нет: рулонов не выдано и на сегодня не запланировано. Нажмите «Все позиции»."
                  : "Позиций нет"
              }
            />
          ) : view === "tiles" ? (
            <Tiles lines={shown} r={r} onOpen={setOpen} />
          ) : (
            <TableView
              lines={shown}
              r={r}
              onOpen={setOpen}
              onDefect={setDefectFor}
              onDetail={setDetailFor}
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
            view === "table"
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
    <Tag color="green" style={{ marginInlineEnd: 0, fontWeight: 700 }}>
      {+e.good || 0}
      {defect ? ` · брак ${defect}` : ""}
      {e.close ? " · закрыть" : ""}
    </Tag>
  );
}

function Tiles({
  lines,
  r,
  onOpen,
}: {
  lines: FastLine[];
  r: R;
  onOpen: (fl: FastLine) => void;
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
                <button
                  key={fl.line.id}
                  onClick={() => onOpen(fl)}
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
                    <Typography.Text strong>
                      {fl.line.part_name ?? "—"}
                    </Typography.Text>
                    <EntryBadge r={r} line={fl.line} />
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {fl.task.production_order_name ?? fl.task.name} · осталось{" "}
                    {fmt(fl.line.remaining_pieces)}
                    {fl.today ? " · на сегодня" : ""}
                    {warn}
                  </Typography.Text>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </Space>
  );
}

function TableView({
  lines,
  r,
  onOpen,
  onDefect,
  onDetail,
}: {
  lines: FastLine[];
  r: R;
  onOpen: (fl: FastLine) => void;
  onDefect: (fl: FastLine) => void;
  onDetail: (fl: FastLine) => void;
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
                  <Typography.Text strong>
                    {fl.line.part_name ?? "—"}
                  </Typography.Text>
                  <div style={{ fontSize: 12, color: "#6B6B68" }}>
                    {fl.task.production_order_name ?? fl.task.name} · осталось{" "}
                    {fmt(fl.line.remaining_pieces)}
                  </div>
                </td>
                <td style={cell}>
                  <div style={{ fontSize: 13 }}>{filmLabel(fl.line)}</div>
                  {roll ? (
                    <Tag color={roll.from ? "cyan" : "blue"}>
                      №{roll.id} · {fmt(roll.left)} м
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
      height={430}
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
          {(fl.line.film_warnings ?? []).map((w) => (
            <Alert key={w} type="warning" showIcon message={w} />
          ))}
          {r.requiresRoll && fl.line.material !== null && (
            <Space wrap>
              <Typography.Text>Рулон:</Typography.Text>
              {rolls.length === 0 ? (
                <Typography.Text type="warning">
                  не выдан — «Подробно…» или выдайте рулон на «Выдаче участку»
                </Typography.Text>
              ) : (
                rolls.map((u) => (
                  <Button
                    key={u.id}
                    type={e.rollId === u.id ? "primary" : "default"}
                    onClick={() => r.setEntry(fl.line, { rollId: u.id })}
                  >
                    №{u.id} · {u.width_mm} мм · {fmt(u.left)} м
                    {u.from ? ` · с «${u.from}»` : ""}
                  </Button>
                ))
              )}
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
            </Space>
          )}
          <Space wrap>
            <Badge count={defect} size="small">
              <Button size="large" onClick={onDefect}>
                Брак…
              </Button>
            </Badge>
            <Button size="large" onClick={onDetail}>
              Подробно… (второй рулон, остаток)
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
