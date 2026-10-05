import { useMemo, useState } from "react";
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
  Table,
  Tabs,
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
  type ReleaseLayout,
  type ReleaseLayoutSheet,
} from "../../../api/productionOrders";
import { listAreas } from "../../../api/areas";
import { listMaterialSkus } from "../../../api/dictionaries";
import { ItemChars } from "../../../components/ItemChars";

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
      const k = `${r.name}|${r.film?.label ?? ""}|${r.film?.strip_width_mm ?? ""}|${r.program ?? ""}|${r.instruction ?? ""}`;
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
      <Table<Agg>
        size="small"
        rowKey="rowKey"
        pagination={false}
        scroll={{ x: "max-content", y: 420 }}
        dataSource={data}
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
    </Space>
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
  preview,
}: {
  order: ProductionOrder;
  picks: PfPick[];
  overrides: Overrides;
  onOverridesChange: (next: Overrides) => void;
  plan: ReleasePlan;
  onPlanChange: (next: ReleasePlan) => void;
  onClose: () => void;
  /** Предпросмотр из графика (ещё нет заказа): только просмотр, без правок и сроков. */
  preview?: { title: string; load: () => Promise<ReleaseLayout> };
}) {
  const list = Object.values(overrides);
  const [shiftDraft, setShiftDraft] = useState<number | null>(plan.shift_days || null);
  const q = useQuery({
    queryKey: ["release-layout", order.id, JSON.stringify(picks), JSON.stringify(list), JSON.stringify(plan), preview?.title],
    queryFn: () => (preview ? preview.load() : getReleaseLayout(order.id, picks, list, plan)),
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
    <Modal open width="96vw" style={{ maxWidth: 1300, top: 16 }} title={preview ? preview.title : `Раскладка запуска — заказ №${order.id} «${order.name}»`} footer={null} onCancel={onClose}>
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
              {preview
                ? "Предпросмотр по графику: ничего не создано. Площадка ламинации — по размеру партии (панель одного цвета и размера от порога — на Фабрику); править строки и сроки — при запуске заказа."
                : "Ничего не запущено — это проверка. Правки уйдут в задания при запуске (кнопкой в окне запуска)."}
            </Typography.Text>
          </Space>
          {!preview && (
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
          )}
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
          <Tabs
            size="small"
            items={[
              ...lay.sheets.map((s) => ({
                key: s.area,
                label: (
                  <span>
                    {s.name} <Typography.Text type="secondary">{s.total}</Typography.Text>
                  </span>
                ),
                children: (
                  <SheetTable
                    sheet={s}
                    overrides={overrides}
                    onEdit={preview ? undefined : (row) => setEditing({ row, sheet: s })}
                    date={plan.dates[s.area]}
                    onDate={
                      preview
                        ? undefined
                        : (dt) => {
                            const dates = { ...plan.dates };
                            if (dt) dates[s.area] = dt;
                            else delete dates[s.area];
                            onPlanChange({ ...plan, dates });
                          }
                    }
                  />
                ),
              })),
              {
                key: "_film",
                label: "Плёнка",
                children: lay.film.length ? (
                  <Table
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
                children: (
                  <Table
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
