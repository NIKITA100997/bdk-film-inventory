import { useState } from "react";
import { Alert, Button, Checkbox, Input, Modal, Select, Space, Table, Tabs, Tag, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  setImportTemplate,
  testImportTemplate,
  type ImportColumn,
  type ImportColumnRole,
  type ImportDefault,
  type ImportRule,
  type ImportTemplate,
  type ImportTemplateTestRow,
  type ItemType,
} from "../../../api/itemTypes";
import { optionLabel } from "../../../utils/optionLabel";
import { apiErrorMessage } from "../../../utils/apiError";

export const IMPORT_ROLE_LABEL: Record<ImportColumnRole, string> = {
  ship_date: "Дата отгрузки",
  invoice: "№ счёта",
  qty: "Количество",
  name: "Наименование",
  property: "Свойство",
  size: "Размер (ширина × высота)",
  skip: "Пропустить",
};

const EMPTY: ImportTemplate = {
  columns: [
    { title: "Дата отгрузки", role: "ship_date" },
    { title: "№ счёта", role: "invoice" },
    { title: "Наименование", role: "name" },
    { title: "Количество", role: "qty" },
  ],
  defaults: [],
  rules: [],
};

/** Кратко: колонки шаблона по порядку — для подсказок. */
export function importColumnsText(type: ItemType): string {
  const props = new Map(type.properties.map((p) => [p.code, p.name]));
  return (type.import_template?.columns ?? [])
    .map((c) =>
      c.title ||
      (c.role === "property" ? props.get(c.code ?? "") : c.role === "size" ? "Размер" : IMPORT_ROLE_LABEL[c.role]) ||
      IMPORT_ROLE_LABEL[c.role],
    )
    .join(", ");
}

/** Шаблон импорта графика у типа (03.10): какие колонки в графике и как
 * из текста наименования получаются свойства. Раньше — зашито под
 * щитовую дверь; теперь другой вид изделий заводится здесь. */
export default function ImportTemplateModal({ type, onClose }: { type: ItemType; onClose: () => void }) {
  const qc = useQueryClient();
  const [tpl, setTpl] = useState<ImportTemplate>(() => structuredClone(type.import_template ?? EMPTY));
  const [sample, setSample] = useState("");
  const [result, setResult] = useState<ImportTemplateTestRow[] | null>(null);
  const props = type.properties;
  const propOptions = props.map((p) => ({ value: p.code, label: `${p.name} (${p.code})` }));
  const numberProps = props.filter((p) => p.value_type === "number").map((p) => ({ value: p.code, label: p.name }));
  const paramOptions = props
    .filter((p) => p.value_type === "list")
    .flatMap((p) => p.option_fields.map((f) => ({ value: `${p.code}.${f.code}`, label: `${p.name} → ${f.name}` })));

  const setCol = (i: number, patch: Partial<ImportColumn>) =>
    setTpl((t) => ({ ...t, columns: t.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const moveCol = (i: number, d: number) =>
    setTpl((t) => {
      const k = i + d;
      if (k < 0 || k >= t.columns.length) return t;
      const cols = [...t.columns];
      [cols[i], cols[k]] = [cols[k], cols[i]];
      return { ...t, columns: cols };
    });
  const setRule = (i: number, patch: Partial<ImportRule>) =>
    setTpl((t) => ({ ...t, rules: (t.rules ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const moveRule = (i: number, d: number) =>
    setTpl((t) => {
      const rules = [...(t.rules ?? [])];
      const k = i + d;
      if (k < 0 || k >= rules.length) return t;
      [rules[i], rules[k]] = [rules[k], rules[i]];
      return { ...t, rules };
    });
  const setDefault = (i: number, patch: Partial<ImportDefault>) =>
    setTpl((t) => ({ ...t, defaults: (t.defaults ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const save = useMutation({
    mutationFn: (t: ImportTemplate | null) => setImportTemplate(type.id, t),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-types"] });
      message.success("Шаблон импорта сохранён");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить шаблон"), 8),
  });
  const test = useMutation({
    mutationFn: () => testImportTemplate(type.id, tpl, sample),
    onSuccess: setResult,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось проверить шаблон"), 8),
  });
  const resultCols = Array.from(new Set((result ?? []).flatMap((r) => Object.keys(r.values))));

  return (
    <Modal
      open
      width={1180}
      title={`Импорт графика — ${type.name}`}
      onCancel={onClose}
      footer={
        <Space>
          {type.import_template && (
            <Button danger onClick={() => save.mutate(null)} loading={save.isPending}>
              Убрать шаблон
            </Button>
          )}
          <Button onClick={onClose}>Отмена</Button>
          <Button type="primary" onClick={() => save.mutate(tpl)} loading={save.isPending}>
            Сохранить
          </Button>
        </Space>
      }
    >
      <Tabs
        items={[
          {
            key: "columns",
            label: `Колонки (${tpl.columns.length})`,
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  Колонки графика по порядку, как они идут в Excel. Нужны «Наименование» и «Количество»; остальное —
                  свойства позиции. Строка-шапка (названия колонок) и заглушки «#VALUE!» пропускаются сами.
                </Typography.Text>
                <Table<ImportColumn>
                  size="small"
                  pagination={false}
                  rowKey={(_, i) => String(i)}
                  dataSource={tpl.columns}
                  columns={[
                    { title: "№", width: 40, render: (_, __, i) => i + 1 },
                    {
                      title: "Название в графике",
                      render: (_, c, i) => (
                        <Input value={c.title ?? ""} style={{ width: 170 }} onChange={(e) => setCol(i, { title: e.target.value })} />
                      ),
                    },
                    {
                      title: "Что это",
                      render: (_, c, i) => (
                        <Select
                          style={{ width: 210 }}
                          value={c.role}
                          options={Object.entries(IMPORT_ROLE_LABEL).map(([value, label]) => ({ value, label }))}
                          onChange={(role: ImportColumnRole) => setCol(i, { role, code: undefined, codes: undefined, from_name: undefined })}
                        />
                      ),
                    },
                    {
                      title: "Свойство",
                      render: (_, c, i) =>
                        c.role === "property" ? (
                          <Space>
                            <Select
                              showSearch
                              optionFilterProp="label"
                              style={{ width: 220 }}
                              value={c.code}
                              options={propOptions}
                              onChange={(code) => setCol(i, { code })}
                            />
                            {c.code === "цвет" && (
                              <Checkbox checked={!!c.from_name} onChange={(e) => setCol(i, { from_name: e.target.checked })}>
                                из наименования после « - »
                              </Checkbox>
                            )}
                          </Space>
                        ) : c.role === "size" ? (
                          <Space>
                            <Select
                              placeholder="ширина"
                              style={{ width: 140 }}
                              value={c.codes?.[0]}
                              options={numberProps}
                              onChange={(w) => setCol(i, { codes: [w, c.codes?.[1] ?? ""] })}
                            />
                            ×
                            <Select
                              placeholder="высота"
                              style={{ width: 140 }}
                              value={c.codes?.[1]}
                              options={numberProps}
                              onChange={(h) => setCol(i, { codes: [c.codes?.[0] ?? "", h] })}
                            />
                          </Space>
                        ) : null,
                    },
                    {
                      title: "",
                      render: (_, __, i) => (
                        <Space size={4}>
                          <Button size="small" disabled={i === 0} onClick={() => moveCol(i, -1)}>
                            ↑
                          </Button>
                          <Button size="small" disabled={i === tpl.columns.length - 1} onClick={() => moveCol(i, 1)}>
                            ↓
                          </Button>
                          <Button size="small" danger onClick={() => setTpl((t) => ({ ...t, columns: t.columns.filter((_, j) => j !== i) }))}>
                            Убрать
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
                <Button onClick={() => setTpl((t) => ({ ...t, columns: [...t.columns, { title: "", role: "property" }] }))}>
                  + колонка
                </Button>
              </Space>
            ),
          },
          {
            key: "rules",
            label: `Признаки из наименования (${(tpl.rules ?? []).length})`,
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  Правила по порядку: если в тексте найден шаблон — свойство получает значение; более позднее совпавшее
                  правило перекрывает раннее. Флажок — «да», если найдено; текст — найденное в скобках ( ); список — выбранный
                  вариант. Ничего не нашлось — флажок «нет», текст пустой. Шаблон — регулярное выражение без учёта регистра:
                  <code> молдинг|\(м\d</code>, <code>защ[её]лк|pl\s*410</code>.
                </Typography.Text>
                <Table<ImportRule>
                  size="small"
                  pagination={false}
                  rowKey={(_, i) => String(i)}
                  dataSource={tpl.rules ?? []}
                  scroll={{ x: "max-content" }}
                  columns={[
                    { title: "№", width: 36, render: (_, __, i) => i + 1 },
                    {
                      title: "Свойство",
                      render: (_, r, i) => (
                        <Select
                          showSearch
                          optionFilterProp="label"
                          style={{ width: 170 }}
                          value={r.code || undefined}
                          options={propOptions}
                          onChange={(code) => setRule(i, { code, value: undefined, capture: undefined })}
                        />
                      ),
                    },
                    {
                      title: "Где искать",
                      render: (_, r, i) => (
                        <Select
                          allowClear
                          placeholder="наименование"
                          style={{ width: 150 }}
                          value={r.source || undefined}
                          options={props.filter((p) => p.value_type === "text").map((p) => ({ value: p.code, label: p.name }))}
                          onChange={(source) => setRule(i, { source: source ?? undefined })}
                        />
                      ),
                    },
                    {
                      title: "Шаблон",
                      render: (_, r, i) => (
                        <Input
                          value={r.pattern}
                          style={{ width: 300, fontFamily: "monospace", fontSize: 12 }}
                          onChange={(e) => setRule(i, { pattern: e.target.value })}
                        />
                      ),
                    },
                    {
                      title: "Значение",
                      render: (_, r, i) => {
                        const p = props.find((x) => x.code === r.code);
                        if (!p) return null;
                        if (p.value_type === "bool") return <Typography.Text type="secondary">да</Typography.Text>;
                        const capture = (
                          <Checkbox checked={!!r.capture} onChange={(e) => setRule(i, { capture: e.target.checked ? 1 : undefined, value: undefined })}>
                            найденное в ( )
                          </Checkbox>
                        );
                        if (p.value_type === "list")
                          return (
                            <Space>
                              {!r.capture && (
                                <Select
                                  style={{ width: 160 }}
                                  value={r.value}
                                  options={p.options.map((o) => ({ value: o.value, label: optionLabel(o) }))}
                                  onChange={(value) => setRule(i, { value })}
                                />
                              )}
                              {capture}
                            </Space>
                          );
                        return (
                          <Space>
                            {!r.capture && (
                              <Input
                                style={{ width: 140 }}
                                value={r.value ?? ""}
                                placeholder="текст"
                                onChange={(e) => setRule(i, { value: e.target.value })}
                              />
                            )}
                            {capture}
                          </Space>
                        );
                      },
                    },
                    {
                      title: "Совпадение",
                      render: (_, r, i) => (
                        <Checkbox checked={r.take === "last"} onChange={(e) => setRule(i, { take: e.target.checked ? "last" : undefined })}>
                          последнее
                        </Checkbox>
                      ),
                    },
                    {
                      title: "",
                      render: (_, __, i) => (
                        <Space size={4}>
                          <Button size="small" disabled={i === 0} onClick={() => moveRule(i, -1)}>
                            ↑
                          </Button>
                          <Button size="small" disabled={i === (tpl.rules ?? []).length - 1} onClick={() => moveRule(i, 1)}>
                            ↓
                          </Button>
                          <Button size="small" danger onClick={() => setTpl((t) => ({ ...t, rules: (t.rules ?? []).filter((_, j) => j !== i) }))}>
                            Убрать
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
                <Button onClick={() => setTpl((t) => ({ ...t, rules: [...(t.rules ?? []), { code: "", pattern: "" }] }))}>+ правило</Button>
                <Typography.Title level={5} style={{ marginBottom: 0 }}>
                  По умолчанию
                </Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  Значение свойства до правил — из параметра выбранного варианта (кромка по серии), иначе запасное.
                </Typography.Text>
                {(tpl.defaults ?? []).map((d, i) => (
                  <Space key={i} wrap>
                    <Select style={{ width: 170 }} value={d.code || undefined} options={propOptions} onChange={(code) => setDefault(i, { code })} />
                    =
                    <Select
                      allowClear
                      placeholder="параметр варианта"
                      style={{ width: 240 }}
                      value={d.from || undefined}
                      options={paramOptions}
                      onChange={(from) => setDefault(i, { from: from ?? undefined })}
                    />
                    иначе
                    <Input style={{ width: 120 }} value={d.fallback ?? ""} onChange={(e) => setDefault(i, { fallback: e.target.value })} />
                    <Button size="small" danger onClick={() => setTpl((t) => ({ ...t, defaults: (t.defaults ?? []).filter((_, j) => j !== i) }))}>
                      Убрать
                    </Button>
                  </Space>
                ))}
                <Button size="small" onClick={() => setTpl((t) => ({ ...t, defaults: [...(t.defaults ?? []), { code: "" }] }))}>
                  + значение по умолчанию
                </Button>
              </Space>
            ),
          },
          {
            key: "test",
            label: "Проверить",
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  Вставьте несколько строк графика — покажем, какие свойства получит каждая строка по текущему (ещё не
                  сохранённому) шаблону. Ничего не сохраняется.
                </Typography.Text>
                <Input.TextArea
                  rows={5}
                  value={sample}
                  onChange={(e) => setSample(e.target.value)}
                  style={{ fontFamily: "monospace", fontSize: 12 }}
                  placeholder="Строки из Excel…"
                />
                <Button disabled={!sample.trim()} loading={test.isPending} onClick={() => test.mutate()}>
                  Проверить
                </Button>
                {result && result.some((r) => r.errors.length) && (
                  <Alert type="warning" showIcon message={`С ошибками: ${result.filter((r) => r.errors.length).length} из ${result.length}`} />
                )}
                {result && (
                  <Table<ImportTemplateTestRow>
                    size="small"
                    pagination={false}
                    rowKey={(r, i) => `${r.line_no}-${i}`}
                    dataSource={result}
                    scroll={{ x: "max-content", y: 360 }}
                    columns={[
                      { title: "Стр.", dataIndex: "line_no", width: 50 },
                      { title: "Наименование", dataIndex: "name", width: 320, ellipsis: true },
                      ...resultCols.map((c) => ({
                        title: c,
                        key: c,
                        render: (_: unknown, r: ImportTemplateTestRow) => r.values[c] ?? "",
                      })),
                      {
                        title: "Ошибки",
                        render: (_, r) => r.errors.map((e) => <Tag key={e} color="red">{e}</Tag>),
                      },
                    ]}
                  />
                )}
              </Space>
            ),
          },
        ]}
      />
    </Modal>
  );
}
