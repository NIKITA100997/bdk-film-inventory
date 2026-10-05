import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import dayjs from "dayjs";
import {
  Button,
  Checkbox,
  DatePicker,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  type LineOverride,
  type ReleaseLayoutRow,
  type ReleaseLayoutSheet,
} from "../../../api/productionOrders";
import { listAreas } from "../../../api/areas";
import { listMaterialSkus } from "../../../api/dictionaries";
import { ItemChars } from "../../../components/ItemChars";
import ResponsiveTable from "../../../components/ResponsiveTable";

export const d = (s: string | null) => (s ? dayjs(s).format("DD.MM") : "—");
export const period = (a: string | null, b: string | null) => (a && b && a !== b ? `${d(a)}–${d(b)}` : d(a));

export type Overrides = Record<string, LineOverride>;

export interface Agg extends ReleaseLayoutRow {
  rowKey: string;
  keys: string[];
  lines: number;
}

/** Правка строки (или группы строк в «Сводно»): что поменять против расчёта. */
export function EditLineModal({
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
export function SheetTable({
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
            // ширины столбцов заданы явно, таблица пересоздаётся при смене
            // режима — иначе при max-content первый столбец «запоминал»
            // ширину широкого режима и рос при каждом переключении (05.10)
            key={mode}
            tableLayout="fixed"
            exportTitle={`Раскладка запуска: ${sheet.name}${g.op ? ` — ${g.op}` : ""}`}
            cardBreakpoint="xs"
            size="small"
            rowKey="rowKey"
            pagination={false}
            scroll={{ x: 360 + 80 + (mode === "rows" ? 240 : 70) + (hasFilm ? 230 : 0) + 100 + (onEdit ? 56 : 0), y: 420 }}
            dataSource={g.rows}
            columns={[
              {
                title: "Наименование",
                width: 360,
                // п/ф — название (размер в нём уже есть); дверь — характеристики
                // крупно, длинное название мелко (модель, цвет, кромка отдельно).
                render: (_, r) => (
                  <Space direction="vertical" size={2} style={{ wordBreak: "break-word" }}>
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
                      width: 240,
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
                      width: 230,
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
export interface SectionItem {
  key: string;
  label: string;
  sub?: string;
  mark?: string;
  /** заголовок группы — показывается над первым пунктом группы */
  group?: string;
  children: ReactNode;
}

export function SectionsView({ items, initial }: { items: SectionItem[]; initial?: string }) {
  const [sel, setSel] = useState(initial ?? items[0]?.key);
  const cur = items.find((i) => i.key === sel) ?? items[0];
  const wide = Grid.useBreakpoint().lg ?? true;
  const tile = (i: SectionItem, extra?: CSSProperties) => {
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
          ...extra,
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
  };
  const headStyle: CSSProperties = { fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", opacity: 0.6 };
  // группы по порядку появления
  const groups: { group?: string; items: SectionItem[] }[] = [];
  for (const i of items) {
    const last = groups[groups.length - 1];
    if (last && last.group === i.group) last.items.push(i);
    else groups.push({ group: i.group, items: [i] });
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
      {wide ? (
        <div
          role="tablist"
          aria-orientation="vertical"
          style={{ flex: "0 1 280px", minWidth: 220, display: "grid", gap: 4, maxHeight: "70vh", overflowY: "auto" }}
        >
          {groups.map((g, gi) => (
            <div key={g.group ?? `_${gi}`} style={{ display: "grid", gap: 4, marginTop: gi ? 8 : 0 }}>
              {g.group && <div style={headStyle}>{g.group}</div>}
              {g.items.map((i) => tile(i))}
            </div>
          ))}
        </div>
      ) : (
        // Узкий экран (планшет вертикально): разделы — плиткой во всю ширину
        // над содержимым, иначе выбранный раздел уезжал под длинный столбец.
        <div role="tablist" aria-orientation="horizontal" style={{ flex: "1 1 100%", display: "grid", gap: 10 }}>
          {groups.map((g, gi) => (
            <div key={g.group ?? `_${gi}`} style={{ display: "grid", gap: 4 }}>
              {g.group && <div style={headStyle}>{g.group}</div>}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 4 }}>
                {g.items.map((i) => tile(i))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ flex: "1 1 600px", minWidth: 0 }}>{cur?.children}</div>
    </div>
  );
}
