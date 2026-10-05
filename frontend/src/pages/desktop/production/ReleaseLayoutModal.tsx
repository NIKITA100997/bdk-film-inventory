import { useMemo, useState, type ReactNode } from "react";
import dayjs from "dayjs";
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  getReleaseLayout,
  type LineOverride,
  type PfPick,
  type ReleasePlan,
  type ProductionOrder,
  type ReleaseLayoutRow,
  type ReleaseLayoutSheet,
} from "../../../api/productionOrders";
import { listAreas } from "../../../api/areas";
import { listMaterialSkus } from "../../../api/dictionaries";
import { ItemChars } from "../../../components/ItemChars";
import ResponsiveTable from "../../../components/ResponsiveTable";

const d = (s: string | null) => (s ? dayjs(s).format("DD.MM") : "—");
const period = (a: string | null, b: string | null) => (a && b && a !== b ? `${d(a)}–${d(b)}` : d(a));

type Overrides = Record<string, LineOverride>;

interface Agg extends ReleaseLayoutRow {
  rowKey: string;
  keys: string[];
  lines: number;
}

/** Правка строки (или группы строк в «Сводно»): что поменять против расчёта. */
function EditLineModal({
  row,
  sheet,
  overrides,
  onSave,
  onClose,
}: {
  row: Agg;
  sheet: ReleaseLayoutSheet;
  overrides: Overrides;
  onSave: (keys: string[], ov: Omit<LineOverride, "key"> | null) => void;
  onClose: () => void;
}) {
  const [form] = Form.useForm();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const skusQuery = useQuery({ queryKey: ["material-skus", "active"], queryFn: () => listMaterialSkus(false), enabled: !!row.film });
  const current = overrides[row.keys[0]] ?? {};
  const single = row.keys.length === 1;
  return (
    <Modal
      open
      title={single ? `Правка строки: ${row.name}` : `Правка ${row.keys.length} строк: ${row.name}`}
      okText="Применить"
      cancelText="Отмена"
      onCancel={onClose}
      onOk={() =>
        form.validateFields().then((v) => {
          const ov: Omit<LineOverride, "key"> = {
            quantity: single ? v.quantity ?? null : null,
            program: v.program ?? null,
            instruction: v.instruction ?? null,
            material_sku_id: v.material_sku_id ?? null,
            strip_width_mm: v.strip_width_mm ?? null,
            area: v.area && v.area !== sheet.area ? v.area : null,
            skip: !!v.skip,
          };
          onSave(row.keys, ov);
        })
      }
      footer={(_, { OkBtn, CancelBtn }) => (
        <Space>
          {row.keys.some((k) => overrides[k]) && (
            <Button danger onClick={() => onSave(row.keys, null)}>
              Сбросить правку
            </Button>
          )}
          <CancelBtn />
          <OkBtn />
        </Space>
      )}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          quantity: current.quantity ?? row.qty,
          program: current.program ?? row.program ?? undefined,
          instruction: current.instruction ?? row.instruction ?? undefined,
          material_sku_id: current.material_sku_id ?? row.film?.sku_id ?? undefined,
          strip_width_mm: current.strip_width_mm ?? row.film?.strip_width_mm ?? undefined,
          area: current.area ?? sheet.area,
          skip: !!current.skip,
        }}
      >
        {single && (
          <Form.Item name="quantity" label="Количество, шт">
            <InputNumber min={1} style={{ width: 160 }} />
          </Form.Item>
        )}
        <Form.Item name="program" label="Программа станка" extra="Для фрезеровки; нестандартный размер — программа от конструктора">
          <Input placeholder="например, В13.2_(М5х3)" />
        </Form.Item>
        <Form.Item name="instruction" label="Указание мастеру" extra="Видно в задании и в отчёте мастера">
          <Input maxLength={255} placeholder="например, +2 на брак, кромка по образцу" />
        </Form.Item>
        {row.film && (
          <Form.Item name="material_sku_id" label="Плёнка">
            <Select
              showSearch
              optionFilterProp="label"
              loading={skusQuery.isLoading}
              options={(skusQuery.data ?? [])
                .filter((s) => s.thickness.value_mm > 0)
                .map((s) => ({ value: s.id, label: `${s.material.name} ${s.color.name} ${s.thickness.value_mm} мм · ${s.manufacturer.name}` }))}
            />
          </Form.Item>
        )}
        {row.film && row.film.strip_width_mm != null && (
          <Form.Item name="strip_width_mm" label="Ширина штрипса, мм">
            <InputNumber min={1} style={{ width: 160 }} />
          </Form.Item>
        )}
        <Form.Item name="area" label="Участок">
          <Select
            showSearch
            optionFilterProp="label"
            options={(areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
          />
        </Form.Item>
        <Form.Item name="skip" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Checkbox>Не делать этот этап (строка не попадёт в задание)</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Лист участка: «Сводно» — одинаковые позиции сложены (как листы Excel по
 * размерам), «По строкам заказа» — каждая строка со счётом и дверью. У
 * строки «✎» — ручная правка; в «Сводно» она применяется ко всей группе. */
function SheetTable({
  sheet,
  overrides,
  onEdit,
  date,
  onDate,
}: {
  sheet: ReleaseLayoutSheet;
  overrides: Overrides;
  onEdit?: (row: Agg) => void;
  // ручной срок участка: всё по нему — на этот день (следующие — за ним)
  date: string | undefined;
  onDate?: (d: string | null) => void;
}) {
  const [mode, setMode] = useState<"sum" | "rows">("sum");
  const hasFilm = sheet.rows.some((r) => r.film);
  const data: Agg[] = useMemo(() => {
    if (mode === "rows") return sheet.rows.map((r, i) => ({ ...r, rowKey: `${r.key}#${i}`, keys: [r.key], lines: 1 }));
    const m = new Map<string, Agg>();
    for (const r of sheet.rows) {
      const k = `${r.operation ?? ""}|${r.name}|${r.film?.label ?? ""}|${r.film?.strip_width_mm ?? ""}|${r.program ?? ""}|${r.instruction ?? ""}`;
      const a = m.get(k);
      if (a) {
        a.qty += r.qty;
        a.lines += 1;
        if (!a.keys.includes(r.key)) a.keys.push(r.key);
        a.manual = a.manual || r.manual;
        if (a.film && r.film) a.film = { ...a.film, need_m: Math.round((a.film.need_m + r.film.need_m) * 10) / 10 };
        if (r.date_from && (!a.date_from || r.date_from < a.date_from)) a.date_from = r.date_from;
        if (r.date_to && (!a.date_to || r.date_to > a.date_to)) a.date_to = r.date_to;
      } else m.set(k, { ...r, film: r.film ? { ...r.film } : null, rowKey: k, keys: [r.key], lines: 1 });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [sheet, mode]);
  // Несколько операций на одном участке — один лист, разбитый по операциям
  // (порядок — как в маршруте), с подытогом у каждой.
  const groups = useMemo(() => {
    const order: string[] = [];
    for (const r of sheet.rows) if (!order.includes(r.operation ?? "")) order.push(r.operation ?? "");
    return order.map((op) => {
      const rows = data.filter((r) => (r.operation ?? "") === op);
      return { op, rows, total: Math.round(rows.reduce((t, r) => t + r.qty, 0) * 100) / 100 };
    });
  }, [sheet, data]);

  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <Space wrap>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as "sum" | "rows")}
          options={[
            { value: "sum", label: "Сводно" },
            { value: "rows", label: "По строкам заказа" },
          ]}
        />
        <Typography.Text type="secondary">
          Всего {sheet.total} шт · срок {period(sheet.date_from, sheet.date_to)}
          {sheet.cut_on_site && " · плёнку режут на участке — выдаётся рулон целиком"}
        </Typography.Text>
        {onDate && (
          <Space size={4}>
            <Typography.Text>Поставить участок на дату:</Typography.Text>
            <DatePicker
              size="small"
              format="DD.MM.YYYY"
              value={date ? dayjs(date) : null}
              onChange={(v) => onDate(v ? v.format("YYYY-MM-DD") : null)}
            />
            {date && <Tag color="orange">срок вручную</Tag>}
          </Space>
        )}
      </Space>
      {groups.map((g) => (
        <div key={g.op || "-"} style={{ display: "grid", gap: 6 }}>
          {groups.length > 1 && (
            <Typography.Text strong>
              Операция «{g.op || "—"}» · {g.total} шт
            </Typography.Text>
          )}
          <ResponsiveTable<Agg>
            exportTitle={`Раскладка запуска: ${sheet.name}${g.op ? ` — ${g.op}` : ""}`}
            cardBreakpoint="xs"
            size="small"
            rowKey="rowKey"
            pagination={false}
            scroll={{ x: "max-content", y: 420 }}
            dataSource={g.rows}
            columns={[
              {
                title: "Наименование",
                // п/ф — название (размер в нём уже есть); дверь — характеристики
                // крупно, длинное название мелко (модель, цвет, кромка отдельно).
                render: (_, r) => (
                  <Space direction="vertical" size={2}>
                    {r.door == null && r.chars.length ? <ItemChars chars={r.chars} name={r.name} strong={false} /> : <span>{r.name}</span>}
                    <Space size={4} wrap>
                      {r.program && <Tag color="geekblue">программа {r.program}</Tag>}
                      {r.instruction && <Typography.Text type="warning">⚑ {r.instruction}</Typography.Text>}
                      {(r.manual || r.keys.some((k) => overrides[k])) && <Tag color="orange">изменено вручную</Tag>}
                    </Space>
                  </Space>
                ),
              },
              { title: "Кол-во", dataIndex: "qty", align: "right", width: 80, render: (v: number) => <b>{v}</b> },
              ...(mode === "rows"
                ? [
                    {
                      title: "Для двери / счёт",
                      render: (_: unknown, r: Agg) => (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {[r.door, r.note].filter(Boolean).join(" · ")}
                        </Typography.Text>
                      ),
                    },
                  ]
                : [{ title: "Строк", dataIndex: "lines", width: 70, align: "right" as const }]),
              ...(hasFilm
                ? [
                    {
                      title: "Плёнка",
                      render: (_: unknown, r: Agg) =>
                        r.film ? (
                          <Space direction="vertical" size={0}>
                            <span>{r.film.label}</span>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {r.film.strip_width_mm ? `штрипс ${r.film.strip_width_mm} мм` : "рулон, режут на участке"} · {r.film.need_m} м
                            </Typography.Text>
                          </Space>
                        ) : (
                          <Tag color="red">не определена</Tag>
                        ),
                    },
                  ]
                : []),
              { title: "Срок", width: 100, render: (_, r) => period(r.date_from, r.date_to) },
              ...(onEdit
                ? [
                    {
                      title: "",
                      width: 56,
                      render: (_: unknown, r: Agg) => (
                        <Button size="small" title={r.keys.length > 1 ? `Править ${r.keys.length} строк` : "Править строку"} onClick={() => onEdit(r)}>
                          ✎
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      ))}
    </Space>
  );
}

/** Разделы раскладки: список слева (все участки видны сразу, без «…»),
 * выбранный лист — справа; на узком экране — список сверху. */
function SectionsView({ items }: { items: { key: string; label: string; sub?: string; mark?: string; children: ReactNode }[] }) {
  const [sel, setSel] = useState(items[0]?.key);
  const cur = items.find((i) => i.key === sel) ?? items[0];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
      <div
        role="tablist"
        aria-orientation="vertical"
        style={{ flex: "0 1 280px", minWidth: 220, display: "grid", gap: 4, maxHeight: "70vh", overflowY: "auto" }}
      >
        {items.map((i) => {
          const on = i.key === cur?.key;
          return (
            <button
              key={i.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSel(i.key)}
              style={{
                textAlign: "left",
                padding: "7px 10px",
                borderRadius: 8,
                border: `1px solid ${on ? "#C97A2B" : "rgba(128,128,128,.25)"}`,
                background: on ? "rgba(201,122,43,.10)" : "transparent",
                cursor: "pointer",
                font: "inherit",
                color: "inherit",
                ...(i.key.startsWith("_") && !items[items.indexOf(i) - 1]?.key.startsWith("_") ? { marginTop: 8 } : {}),
              }}
            >
              <div style={{ fontWeight: on ? 600 : 500 }}>{i.label}</div>
              {(i.sub || i.mark) && (
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {i.sub}
                  {i.mark && <Tag color="orange" style={{ marginLeft: 6, fontSize: 11 }}>{i.mark}</Tag>}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ flex: "1 1 600px", minWidth: 0 }}>{cur?.children}</div>
    </div>
  );
}

/** Раскладка перед запуском: запуск выполняется на сервере по-настоящему и
 * откатывается — показ совпадает с тем, что родится. Листы как в
 * Excel-мониторе: по участкам в порядке сроков, плюс плёнка и материалы.
 * Ручные правки строк применяются сразу (раскладка пересчитывается) и
 * уходят в задания при запуске. */
export default function ReleaseLayoutModal({
  order,
  picks,
  overrides,
  onOverridesChange,
  plan,
  onPlanChange,
  onClose,
}: {
  order: ProductionOrder;
  picks: PfPick[];
  overrides: Overrides;
  onOverridesChange: (next: Overrides) => void;
  plan: ReleasePlan;
  onPlanChange: (next: ReleasePlan) => void;
  onClose: () => void;
}) {
  const list = Object.values(overrides);
  const [shiftDraft, setShiftDraft] = useState<number | null>(plan.shift_days || null);
  const q = useQuery({
    queryKey: ["release-layout", order.id, JSON.stringify(picks), JSON.stringify(list), JSON.stringify(plan)],
    queryFn: () => getReleaseLayout(order.id, picks, list, plan),
    staleTime: 0,
    gcTime: 0,
    placeholderData: (prev) => prev,
  });
  const lay = q.data;
  const [editing, setEditing] = useState<{ row: Agg; sheet: ReleaseLayoutSheet } | null>(null);
  const save = (keys: string[], ov: Omit<LineOverride, "key"> | null) => {
    const next = { ...overrides };
    for (const k of keys) {
      if (ov) next[k] = { key: k, ...ov };
      else delete next[k];
    }
    onOverridesChange(next);
    setEditing(null);
  };
  return (
    <Modal
      open
      width="calc(100vw - 32px)"
      style={{ maxWidth: 1800, top: 12, paddingBottom: 12 }}
      title={`Раскладка запуска — заказ №${order.id} «${order.name}»`}
      footer={null}
      onCancel={onClose}
    >
      {q.isLoading && <Spin style={{ display: "block", margin: "48px auto" }} />}
      {q.isError && <Alert type="error" showIcon message="Не удалось посчитать раскладку" description={String((q.error as Error)?.message ?? "")} />}
      {lay && (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Typography.Text>
              Дверей: <b>{lay.doors}</b> · участков: <b>{lay.sheets.length}</b> · готово к <b>{d(lay.finish)}</b>
            </Typography.Text>
            {lay.late ? <Tag color="red">не успевает к отгрузке</Tag> : <Tag color="green">успевает</Tag>}
            {q.isFetching && <Spin size="small" />}
            {list.length > 0 && (
              <>
                <Tag color="orange">ручных правок: {list.length}</Tag>
                <Button size="small" onClick={() => onOverridesChange({})}>
                  Сбросить все правки
                </Button>
              </>
            )}
            <Typography.Text type="secondary">
              Ничего не запущено — это проверка. Правки уйдут в задания при запуске (кнопкой в окне запуска).
            </Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text>Весь заказ: сдвинуть на</Typography.Text>
            <InputNumber size="small" style={{ width: 80 }} value={shiftDraft} onChange={setShiftDraft} placeholder="±дн." />
            <Typography.Text>рабочих дней</Typography.Text>
            <Button size="small" onClick={() => onPlanChange({ ...plan, shift_days: shiftDraft ?? 0 })}>
              Применить
            </Button>
            {plan.shift_days !== 0 && <Tag color="orange">заказ сдвинут на {plan.shift_days} раб. дн.</Tag>}
            <Checkbox checked={plan.shift_next} onChange={(e) => onPlanChange({ ...plan, shift_next: e.target.checked })}>
              при переносе участка сдвигать следующие этапы
            </Checkbox>
            {(Object.keys(plan.dates).length > 0 || plan.shift_days !== 0) && (
              <Button
                size="small"
                onClick={() => {
                  setShiftDraft(null);
                  onPlanChange({ ...plan, dates: {}, shift_days: 0 });
                }}
              >
                Сбросить сроки
              </Button>
            )}
          </Space>
          {lay.warnings.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`Проверьте перед запуском: ${lay.warnings.length}`}
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {lay.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              }
            />
          ) : (
            <Alert type="success" showIcon message="Замечаний нет: плёнка определена и хватает, размеры стандартные или программа задана" />
          )}
          <SectionsView
            items={[
              ...lay.sheets.map((s) => ({
                key: s.area,
                label: s.name,
                sub: `${s.total} шт · ${period(s.date_from, s.date_to)}${s.pf ? " · п/ф" : ""}`,
                mark: plan.dates[s.area] ? "срок вручную" : undefined,
                children: (
                  <SheetTable
                    sheet={s}
                    overrides={overrides}
                    onEdit={(row) => setEditing({ row, sheet: s })}
                    date={plan.dates[s.area]}
                    onDate={(dt) => {
                      const dates = { ...plan.dates };
                      if (dt) dates[s.area] = dt;
                      else delete dates[s.area];
                      onPlanChange({ ...plan, dates });
                    }}
                  />
                ),
              })),
              {
                key: "_pf",
                label: "П/ф: со склада и в работу",
                sub: `${lay.pf.length} деталей`,
                children: lay.pf.length ? (
                  <Space direction="vertical" size="small" style={{ width: "100%" }}>
                    <Typography.Text type="secondary">
                      Откуда детали на листах участков: «со склада» — свободный остаток уходит в резерв заказа, «в работу» — по
                      ним заданы операции на участках. Поменять — в окне запуска.
                    </Typography.Text>
                    <ResponsiveTable
                      exportTitle={`Раскладка запуска заказа №${order.id}: п/ф`}
                      cardBreakpoint="xs"
                      size="small"
                      rowKey="name"
                      pagination={false}
                      scroll={{ y: 520 }}
                      dataSource={lay.pf}
                      columns={[
                        { title: "Деталь", dataIndex: "name" },
                        { title: "Нужно", dataIndex: "need", align: "right" },
                        { title: "Со склада", dataIndex: "from_stock", align: "right" },
                        { title: "В работу", dataIndex: "launch", align: "right", render: (v: number) => <b>{v}</b> },
                        { title: "Строк заказа", dataIndex: "order_lines", align: "right" },
                        ...(lay.pf.some((r) => r.lamination_area)
                          ? [{ title: "Ламинация", render: (_: unknown, r: (typeof lay.pf)[number]) => r.lamination_area ?? "" }]
                          : []),
                      ]}
                    />
                  </Space>
                ) : (
                  <Empty description="П/ф для заказа не нужны" />
                ),
              },
              {
                key: "_film",
                label: "Плёнка",
                sub: `${lay.film.length} позиций${lay.film.some((f) => f.stock_m < f.need_m) ? " · не хватает" : ""}`,
                children: lay.film.length ? (
                  <ResponsiveTable
                    exportTitle={`Раскладка запуска заказа №${order.id}: плёнка`}
                    cardBreakpoint="xs"
                    size="small"
                    rowKey={(r) => `${r.area}|${r.label}`}
                    pagination={false}
                    dataSource={lay.film}
                    columns={[
                      { title: "Участок", dataIndex: "area_name" },
                      { title: "Плёнка", dataIndex: "label" },
                      { title: "Нужно, м", dataIndex: "need_m", align: "right" },
                      {
                        title: "На складе площадки, м",
                        align: "right",
                        render: (_, r) => (
                          <Space size={4}>
                            <span>{r.stock_m}</span>
                            {r.stock_m < r.need_m ? <Tag color="red">не хватает</Tag> : <Tag color="green">хватает</Tag>}
                          </Space>
                        ),
                      },
                      {
                        title: "Как выдаётся",
                        render: (_, r) =>
                          r.cut_on_site ? `рулон не уже ${r.min_width_mm} мм, режут на участке` : `штрипсы от ${r.min_width_mm} мм, режет склад`,
                      },
                    ]}
                  />
                ) : (
                  <Empty description="Плёнки в этом запуске нет" />
                ),
              },
              {
                key: "_mat",
                label: "Материалы и комплектующие",
                sub: `${lay.materials.length} позиций`,
                children: (
                  <ResponsiveTable
                    exportTitle={`Раскладка запуска заказа №${order.id}: материалы и комплектующие`}
                    cardBreakpoint="xs"
                    size="small"
                    rowKey="name"
                    pagination={false}
                    scroll={{ y: 460 }}
                    dataSource={lay.materials}
                    columns={[
                      { title: "Наименование", dataIndex: "name" },
                      {
                        title: "Количество",
                        align: "right",
                        render: (_, r) => `${Math.round(r.qty * 100) / 100} ${r.unit ?? "шт"}`,
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </Space>
      )}
      {editing && (
        <EditLineModal row={editing.row} sheet={editing.sheet} overrides={overrides} onSave={save} onClose={() => setEditing(null)} />
      )}
    </Modal>
  );
}
