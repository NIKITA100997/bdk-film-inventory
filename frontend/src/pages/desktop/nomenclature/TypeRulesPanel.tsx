import { useState } from "react";
import { isAxiosError } from "axios";
import { Alert, Button, Card, Col, Form, Input, Modal, Row, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas } from "../../../api/areas";
import { listParts } from "../../../api/dictionaries";
import {
  applyTypeRules,
  createItemByType,
  listItemTypes,
  previewTypeRules,
  setTypeComponentRules,
  setTypeOperations,
  updateItemType,
  type ItemType,
  type PropertyValue,
  type RulesPreview,
  type TypeComponentRule,
  type TypeOperation,
} from "../../../api/itemTypes";
import PropertyInputs from "./PropertyInputs";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const emptyRule: TypeComponentRule = {
  name_template: "",
  qty_expr: "1",
  condition: null,
  width_expr: null,
  length_expr: null,
  strip_width_expr: null,
  route_part_id: null,
  operation_name: null,
  component_type_id: null,
  component_values: {},
};

/** Правила типа изделия (единая модель, пункт 3): название позиции по
 * шаблону, маршрут из операций с условиями, состав по формулам. Формулы —
 * через коды свойств: «ширина + 10», «серия.толщина_каркаса»,
 * «серия.кромка == "abs"». */
export default function TypeRulesPanel({ type, canManage }: { type: ItemType; canManage: boolean }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["item-types"] });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const areaName = (code: string | null) =>
    code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "общий запас, с любого участка";
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  // Тип компонента — только вида «П/ф» (компонент заводится деталью).
  const pfTypes = (typesQuery.data ?? []).filter((t) => t.kind_code === "pf" && t.id !== type.id);
  const typeName = (id: number | null) => (typesQuery.data ?? []).find((t) => t.id === id)?.name;

  const [nameTpl, setNameTpl] = useState<string | null>(null);
  const [opsDraft, setOpsDraft] = useState<TypeOperation[] | null>(null);
  const [rulesDraft, setRulesDraft] = useState<TypeComponentRule[] | null>(null);
  const [checkOpen, setCheckOpen] = useState<"preview" | "create" | null>(null);

  const codes = type.properties.map((p) => {
    const params = p.option_fields.map((f) => `${p.code}.${f.code}`);
    return [p.code, ...params];
  });

  const nameMutation = useMutation({
    mutationFn: (tpl: string) => updateItemType(type.id, { name_template: tpl }),
    onSuccess: () => {
      invalidate();
      setNameTpl(null);
      message.success("Шаблон названия сохранён");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить шаблон")),
  });
  const opsMutation = useMutation({
    mutationFn: (ops: TypeOperation[]) => setTypeOperations(type.id, ops.map((o) => ({ ...o, area: o.area || null }))),
    onSuccess: () => {
      invalidate();
      setOpsDraft(null);
      message.success("Маршрут типа сохранён");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить маршрут")),
  });
  const rulesMutation = useMutation({
    mutationFn: (rules: TypeComponentRule[]) => setTypeComponentRules(type.id, rules),
    onSuccess: () => {
      invalidate();
      setRulesDraft(null);
      message.success("Правила состава сохранены");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить правила")),
  });
  const applyMutation = useMutation({
    mutationFn: () => applyTypeRules(type.id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["techcard"] });
      const failed = Object.entries(res.errors);
      if (failed.length === 0) message.success(`Пересчитано позиций: ${res.applied}`);
      else
        Modal.warning({
          title: `Пересчитано: ${res.applied}, не пересчитано: ${failed.length}`,
          content: (
            <ul>
              {failed.map(([name, errs]) => (
                <li key={name}>
                  {name}: {errs.join("; ")}
                </li>
              ))}
            </ul>
          ),
        });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось пересчитать")),
  });

  const patchOp = (i: number, p: Partial<TypeOperation>) =>
    setOpsDraft((d) => (d ?? []).map((o, j) => (j === i ? { ...o, ...p } : o)));
  const patchRule = (i: number, p: Partial<TypeComponentRule>) =>
    setRulesDraft((d) => (d ?? []).map((r, j) => (j === i ? { ...r, ...p } : r)));
  const opNames = (opsDraft ?? type.operations).map((o) => o.name).filter(Boolean);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="Формулы и условия — через коды свойств"
        description={
          <Space size={[4, 4]} wrap>
            {codes.flat().map((c) => (
              <Tag key={c} style={{ fontFamily: "monospace" }}>
                {c}
              </Tag>
            ))}
            <Typography.Text type="secondary">
              Примеры: <code>ширина + 10</code>, <code>серия.толщина_каркаса</code>, <code>серия.кромка == "abs"</code>,{" "}
              <code>замок and not стекло</code>. В названиях — формулы в фигурных скобках: <code>Каркас {"{ширина+10}"}х{"{высота+10}"}</code>.
            </Typography.Text>
          </Space>
        }
      />

      <section>
        <Typography.Title level={5}>Название позиции</Typography.Title>
        {nameTpl === null ? (
          <Space>
            <Typography.Text code={!!type.name_template}>{type.name_template ?? "не задано"}</Typography.Text>
            {canManage && (
              <Button size="small" onClick={() => setNameTpl(type.name_template ?? "")}>
                Изменить
              </Button>
            )}
          </Space>
        ) : (
          <Space wrap>
            <Input
              style={{ width: 460 }}
              value={nameTpl}
              placeholder="Дверь щитовая {серия} {ширина}х{высота}"
              onChange={(e) => setNameTpl(e.target.value)}
            />
            <Button type="primary" size="small" loading={nameMutation.isPending} onClick={() => nameMutation.mutate(nameTpl)}>
              Сохранить
            </Button>
            <Button size="small" onClick={() => setNameTpl(null)}>
              Отмена
            </Button>
          </Space>
        )}
      </section>

      <section>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Маршрут типа
          </Typography.Title>
          {canManage && opsDraft === null && (
            <Button size="small" onClick={() => setOpsDraft(type.operations.map((o) => ({ ...o })))}>
              Изменить
            </Button>
          )}
        </Space>
        {opsDraft === null ? (
          type.operations.length === 0 ? (
            <Typography.Text type="secondary">Операции не заданы.</Typography.Text>
          ) : (
            <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              {type.operations.map((o) => (
                <li key={o.name}>
                  {o.name} <Typography.Text type="secondary">— {areaName(o.area)}</Typography.Text>
                  {o.condition && (
                    <Tag style={{ marginLeft: 8, fontFamily: "monospace" }} color="purple">
                      если {o.condition}
                    </Tag>
                  )}
                </li>
              ))}
            </ol>
          )
        ) : (
          <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
            {opsDraft.map((o, i) => (
              <Space key={i} wrap>
                <Typography.Text type="secondary">{i + 1}.</Typography.Text>
                <Input placeholder="Операция" value={o.name} style={{ width: 200 }} onChange={(e) => patchOp(i, { name: e.target.value })} />
                <Select
                  showSearch
                  allowClear={i === opsDraft.length - 1}
                  optionFilterProp="label"
                  placeholder={i === opsDraft.length - 1 ? "Участок (пусто — общий запас)" : "Участок"}
                  style={{ width: 260 }}
                  value={o.area || undefined}
                  options={areaOptions}
                  onChange={(v) => patchOp(i, { area: v ?? null })}
                />
                <Input
                  placeholder="условие (пусто — всегда)"
                  value={o.condition ?? ""}
                  style={{ width: 240, fontFamily: "monospace" }}
                  onChange={(e) => patchOp(i, { condition: e.target.value || null })}
                />
                <Button size="small" danger onClick={() => setOpsDraft((d) => (d ?? []).filter((_, j) => j !== i))}>
                  Убрать
                </Button>
              </Space>
            ))}
            <Space>
              <Button onClick={() => setOpsDraft((d) => [...(d ?? []), { name: "", area: "", condition: null }])}>+ операция</Button>
              <Button type="primary" loading={opsMutation.isPending} onClick={() => opsMutation.mutate(opsDraft)}>
                Сохранить
              </Button>
              <Button onClick={() => setOpsDraft(null)}>Отмена</Button>
            </Space>
          </Space>
        )}
      </section>

      <section>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Правила состава
          </Typography.Title>
          {canManage && rulesDraft === null && (
            <Button size="small" onClick={() => setRulesDraft(type.component_rules.map((r) => ({ ...r })))}>
              Изменить
            </Button>
          )}
        </Space>
        {rulesDraft === null ? (
          type.component_rules.length === 0 ? (
            <Typography.Text type="secondary">Правил нет.</Typography.Text>
          ) : (
            <Table<TypeComponentRule>
              size="small"
              style={{ marginTop: 8 }}
              rowKey={(_, i) => String(i)}
              pagination={false}
              dataSource={type.component_rules}
              columns={[
                {
                  title: "Компонент",
                  render: (_, r) =>
                    r.component_type_id ? (
                      <Space direction="vertical" size={0}>
                        <Tag color="purple">тип: {typeName(r.component_type_id) ?? "—"}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {Object.entries(r.component_values)
                            .map(([k, v]) => `${k} = ${v}`)
                            .join("; ")}
                        </Typography.Text>
                      </Space>
                    ) : (
                      <code>{r.name_template}</code>
                    ),
                },
                { title: "На 1 шт", render: (_, r) => <code>{r.qty_expr}</code> },
                {
                  title: "Размеры, мм",
                  render: (_, r) =>
                    r.width_expr || r.length_expr ? (
                      <code>
                        {r.width_expr ?? "—"} × {r.length_expr ?? "—"}
                      </code>
                    ) : (
                      "—"
                    ),
                },
                { title: "Условие", render: (_, r) => (r.condition ? <code>{r.condition}</code> : "всегда") },
                { title: "Операция", render: (_, r) => r.operation_name ?? "—" },
              ]}
            />
          )
        ) : (
          <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
            {rulesDraft.map((r, i) => (
              <Card key={i} size="small">
                <Row gutter={[8, 8]}>
                  <Col xs={24} md={14}>
                    <Input
                      addonBefore="Компонент"
                      placeholder="Каркас {ширина+10}х{высота+10}х{серия.толщина_каркаса}"
                      value={r.name_template}
                      style={{ fontFamily: "monospace" }}
                      onChange={(e) => patchRule(i, { name_template: e.target.value })}
                    />
                  </Col>
                  <Col xs={12} md={4}>
                    <Input addonBefore="на 1 шт" value={r.qty_expr} onChange={(e) => patchRule(i, { qty_expr: e.target.value })} />
                  </Col>
                  <Col xs={12} md={6}>
                    <Input
                      addonBefore="если"
                      placeholder="всегда"
                      value={r.condition ?? ""}
                      onChange={(e) => patchRule(i, { condition: e.target.value || null })}
                    />
                  </Col>
                  <Col xs={12} md={6}>
                    <Input addonBefore="ширина, мм" value={r.width_expr ?? ""} onChange={(e) => patchRule(i, { width_expr: e.target.value || null })} />
                  </Col>
                  <Col xs={12} md={6}>
                    <Input addonBefore="длина, мм" value={r.length_expr ?? ""} onChange={(e) => patchRule(i, { length_expr: e.target.value || null })} />
                  </Col>
                  <Col xs={12} md={6}>
                    <Input
                      addonBefore="штрипс, мм"
                      value={r.strip_width_expr ?? ""}
                      onChange={(e) => patchRule(i, { strip_width_expr: e.target.value || null })}
                    />
                  </Col>
                  <Col xs={12} md={6}>
                    <Select
                      allowClear
                      placeholder="Операция расхода"
                      style={{ width: "100%" }}
                      value={r.operation_name ?? undefined}
                      options={opNames.map((n) => ({ value: n, label: n }))}
                      onChange={(v) => patchRule(i, { operation_name: v ?? null })}
                    />
                  </Col>
                  <Col xs={24} md={18}>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder="Маршрут новой позиции — как у детали…"
                      style={{ width: "100%" }}
                      value={r.route_part_id ?? undefined}
                      options={(partsQuery.data ?? [])
                        .filter((p) => p.is_active && p.stages.length > 0)
                        .map((p) => ({ value: p.id, label: `${p.name} · ${p.stages.map((s) => s.name).join(" → ")}` }))}
                      onChange={(v) => patchRule(i, { route_part_id: v ?? null })}
                    />
                  </Col>
                  <Col xs={24} md={10}>
                    <Select
                      allowClear
                      placeholder="…или компонент со своим типом (п/ф)"
                      style={{ width: "100%" }}
                      value={r.component_type_id ?? undefined}
                      options={pfTypes.map((t) => ({ value: t.id, label: t.name }))}
                      onChange={(v) => patchRule(i, { component_type_id: v ?? null, component_values: {} })}
                    />
                  </Col>
                  {r.component_type_id &&
                    (typesQuery.data ?? [])
                      .find((t) => t.id === r.component_type_id)
                      ?.properties.map((p) => (
                        <Col xs={12} md={7} key={p.code}>
                          <Input
                            addonBefore={p.code}
                            placeholder="формула"
                            value={r.component_values[p.code] ?? ""}
                            style={{ fontFamily: "monospace" }}
                            onChange={(e) => patchRule(i, { component_values: { ...r.component_values, [p.code]: e.target.value } })}
                          />
                        </Col>
                      ))}
                  <Col xs={24} md={6}>
                    <Button danger block onClick={() => setRulesDraft((d) => (d ?? []).filter((_, j) => j !== i))}>
                      Убрать правило
                    </Button>
                  </Col>
                </Row>
              </Card>
            ))}
            <Space>
              <Button onClick={() => setRulesDraft((d) => [...(d ?? []), { ...emptyRule }])}>+ правило</Button>
              <Button type="primary" loading={rulesMutation.isPending} onClick={() => rulesMutation.mutate(rulesDraft)}>
                Сохранить
              </Button>
              <Button onClick={() => setRulesDraft(null)}>Отмена</Button>
            </Space>
          </Space>
        )}
      </section>

      <Space wrap>
        <Button onClick={() => setCheckOpen("preview")} disabled={type.properties.length === 0}>
          Проверить на значениях
        </Button>
        {canManage && (
          <Button onClick={() => setCheckOpen("create")} disabled={!type.name_template}>
            Создать позицию
          </Button>
        )}
        {canManage && (
          <Button loading={applyMutation.isPending} disabled={type.item_count === 0} onClick={() => applyMutation.mutate()}>
            Пересчитать позиции типа ({type.item_count})
          </Button>
        )}
      </Space>
      {checkOpen && <CheckModal type={type} mode={checkOpen} onClose={() => setCheckOpen(null)} areaName={areaName} />}
    </Space>
  );
}

function CheckModal({
  type,
  mode,
  onClose,
  areaName,
}: {
  type: ItemType;
  mode: "preview" | "create";
  onClose: () => void;
  areaName: (code: string | null) => string;
}) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, PropertyValue>>({});
  const [result, setResult] = useState<RulesPreview | null>(null);
  const previewMutation = useMutation({
    mutationFn: () => previewTypeRules(type.id, { values }),
    onSuccess: setResult,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось проверить")),
  });
  const createMutation = useMutation({
    mutationFn: () => createItemByType(type.id, values),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["item-types"] });
      message.success(res.created ? `Создана позиция «${res.name}»` : `Такая позиция уже есть: «${res.name}»`);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать позицию")),
  });

  return (
    <Modal
      open
      width={880}
      title={mode === "create" ? `Новая позиция — ${type.name}` : `Проверка правил — ${type.name}`}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button loading={previewMutation.isPending} onClick={() => previewMutation.mutate()}>
            Проверить
          </Button>
          {mode === "create" && (
            <Button type="primary" loading={createMutation.isPending} onClick={() => createMutation.mutate()}>
              Создать
            </Button>
          )}
        </Space>
      }
    >
      <Row gutter={24}>
        <Col xs={24} md={10}>
          <Form layout="vertical">
            <PropertyInputs type={type} values={values} onChange={setValues} />
          </Form>
        </Col>
        <Col xs={24} md={14}>
          {!result ? (
            <Typography.Text type="secondary">Заполните свойства и нажмите «Проверить» — покажу, что получится.</Typography.Text>
          ) : (
            <Space direction="vertical" style={{ width: "100%" }}>
              {result.errors.length > 0 && (
                <Alert type="error" showIcon message="Не хватает данных" description={<ul style={{ margin: 0 }}>{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>} />
              )}
              {result.name && (
                <Typography.Text>
                  Название: <b>{result.name}</b>
                </Typography.Text>
              )}
              <Typography.Text strong>Маршрут</Typography.Text>
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {result.operations.map((o) => (
                  <li key={o.name}>
                    {o.name} <Typography.Text type="secondary">— {areaName(o.area)}</Typography.Text>
                  </li>
                ))}
              </ol>
              <Typography.Text strong>Состав на 1 шт</Typography.Text>
              <Table
                size="small"
                rowKey="name"
                pagination={false}
                dataSource={result.components}
                columns={[
                  {
                    title: "Компонент",
                    render: (_, c) => (
                      <Space size={4} wrap>
                        <span>{c.name}</span>
                        {c.exists ? <Tag>есть</Tag> : <Tag color="green">будет создан</Tag>}
                      </Space>
                    ),
                  },
                  { title: "Кол-во", render: (_, c) => c.qty },
                  { title: "Размер, мм", render: (_, c) => (c.width_mm ? `${c.width_mm} × ${c.length_mm}` : "—") },
                  { title: "Операция", render: (_, c) => c.operation_name ?? "—" },
                ]}
              />
            </Space>
          )}
        </Col>
      </Row>
    </Modal>
  );
}
