import { useState } from "react";
import { isAxiosError } from "axios";
import {
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../../auth/AuthContext";
import TypeRulesPanel from "./TypeRulesPanel";
import { listItemKinds } from "../../../api/items";
import {
  PROPERTY_TYPE_LABEL,
  createItemType,
  createProperty,
  deleteItemType,
  deleteProperty,
  listItemTypes,
  replacePropertyOptions,
  updateItemType,
  updateProperty,
  type ItemProperty,
  type OptionField,
  type PropertyInput,
} from "../../../api/itemTypes";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** Типы изделий и их свойства (единая модель, пункты 1–2). Слева — типы по
 * видам номенклатуры, справа — свойства выбранного типа. Новый вид
 * продукции (щитовая, царговая, металлическая дверь) — настройка здесь, а не
 * новая программа. */
export default function TypesTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage =
    !!user?.is_superuser ||
    !!user?.permissions.includes("production_tasks.manage") ||
    !!user?.permissions.includes("materials.manage");
  const kindsQuery = useQuery({ queryKey: ["item-kinds"], queryFn: listItemKinds });
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newType, setNewType] = useState<{ kind_code: string; name: string } | null>(null);
  const [propTarget, setPropTarget] = useState<{ typeId: number; prop: ItemProperty | null } | null>(null);
  const [optionsTarget, setOptionsTarget] = useState<ItemProperty | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const types = typesQuery.data ?? [];
  // Ничего не выбрано — показываем первый тип.
  const selected = types.find((t) => t.id === selectedId) ?? types[0] ?? null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["item-types"] });
  const createTypeMutation = useMutation({
    mutationFn: createItemType,
    onSuccess: (t) => {
      invalidate();
      setSelectedId(t.id);
      setNewType(null);
      message.success("Тип создан");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать тип")),
  });
  const updateTypeMutation = useMutation({
    mutationFn: (v: { id: number; name?: string; is_active?: boolean }) => updateItemType(v.id, v),
    onSuccess: () => {
      invalidate();
      setRenaming(null);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить тип")),
  });
  const deleteTypeMutation = useMutation({
    mutationFn: deleteItemType,
    onSuccess: () => {
      invalidate();
      setSelectedId(null);
      message.success("Тип удалён");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить тип")),
  });
  const deletePropMutation = useMutation({
    mutationFn: deleteProperty,
    onSuccess: () => {
      invalidate();
      message.success("Свойство удалено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить свойство")),
  });

  const kinds = kindsQuery.data ?? [];

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card
          title="Типы"
          extra={
            canManage && (
              <Button size="small" type="primary" onClick={() => setNewType({ kind_code: "izdelie", name: "" })}>
                + Тип
              </Button>
            )
          }
        >
          <Typography.Paragraph type="secondary">
            Тип внутри вида номенклатуры: например, ГП → «Щитовая дверь». Тип задаёт свойства позиций.
          </Typography.Paragraph>
          {types.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Типов пока нет" />
          ) : (
            kinds.map((k) => {
              const ofKind = types.filter((t) => t.kind_code === k.code);
              if (ofKind.length === 0) return null;
              return (
                <div key={k.code} style={{ marginBottom: 12 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12, letterSpacing: 0.5 }}>
                    {k.name.toUpperCase()}
                  </Typography.Text>
                  <List
                    size="small"
                    dataSource={ofKind}
                    renderItem={(t) => (
                      <List.Item
                        onClick={() => setSelectedId(t.id)}
                        style={{
                          cursor: "pointer",
                          background: t.id === selected?.id ? "var(--ant-color-primary-bg, #fff4e6)" : undefined,
                          paddingInline: 8,
                        }}
                      >
                        <Space>
                          <span>{t.name}</span>
                          {!t.is_active && <Tag>архив</Tag>}
                        </Space>
                        <Typography.Text type="secondary">{t.item_count} поз.</Typography.Text>
                      </List.Item>
                    )}
                  />
                </div>
              );
            })
          )}
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        {selected ? (
          <Card
            title={
              renaming !== null ? (
                <Space>
                  <Input value={renaming} onChange={(e) => setRenaming(e.target.value)} style={{ width: 280 }} />
                  <Button
                    type="primary"
                    size="small"
                    loading={updateTypeMutation.isPending}
                    onClick={() => updateTypeMutation.mutate({ id: selected.id, name: renaming })}
                  >
                    Сохранить
                  </Button>
                  <Button size="small" onClick={() => setRenaming(null)}>
                    Отмена
                  </Button>
                </Space>
              ) : (
                <Space>
                  <span>{selected.name}</span>
                  <Tag>{selected.kind_name}</Tag>
                </Space>
              )
            }
            extra={
              canManage &&
              renaming === null && (
                <Space>
                  <Button size="small" onClick={() => setRenaming(selected.name)}>
                    Переименовать
                  </Button>
                  <Button
                    size="small"
                    onClick={() => updateTypeMutation.mutate({ id: selected.id, is_active: !selected.is_active })}
                  >
                    {selected.is_active ? "В архив" : "Из архива"}
                  </Button>
                  <Popconfirm
                    title="Удалить тип?"
                    description={selected.item_count > 0 ? "У типа есть позиции — удалить не получится." : undefined}
                    okText="Удалить"
                    cancelText="Отмена"
                    onConfirm={() => deleteTypeMutation.mutate(selected.id)}
                  >
                    <Button size="small" danger>
                      Удалить
                    </Button>
                  </Popconfirm>
                </Space>
              )
            }
          >
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Space style={{ justifyContent: "space-between", width: "100%" }}>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  Свойства
                </Typography.Title>
                {canManage && (
                  <Button size="small" onClick={() => setPropTarget({ typeId: selected.id, prop: null })}>
                    + Свойство
                  </Button>
                )}
              </Space>
              <Table<ItemProperty>
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={selected.properties}
                locale={{ emptyText: "Свойств пока нет — например, ширина, высота, серия" }}
                columns={[
                  {
                    title: "Свойство",
                    render: (_, p) => (
                      <Space direction="vertical" size={0}>
                        <Space size={4}>
                          <span>{p.name}</span>
                          {p.is_required && <Tag color="orange">обязательное</Tag>}
                        </Space>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          код: {p.code}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: "Значение",
                    render: (_, p) => `${PROPERTY_TYPE_LABEL[p.value_type]}${p.unit ? `, ${p.unit}` : ""}`,
                  },
                  {
                    title: "Варианты",
                    render: (_, p) =>
                      p.value_type !== "list" ? (
                        "—"
                      ) : (
                        <Space direction="vertical" size={2}>
                          <span>
                            {p.options.length === 0
                              ? "нет"
                              : p.options
                                  .slice(0, 6)
                                  .map((o) => o.value)
                                  .join(", ") + (p.options.length > 6 ? ` … всего ${p.options.length}` : "")}
                          </span>
                          {p.option_fields.length > 0 && (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              параметры: {p.option_fields.map((f) => f.name).join(", ")}
                            </Typography.Text>
                          )}
                        </Space>
                      ),
                  },
                  { title: "Заполнено", render: (_, p) => (p.used ? `${p.used} поз.` : "—") },
                  {
                    title: "",
                    render: (_, p) =>
                      canManage && (
                        <Space size={4} wrap>
                          <Button size="small" onClick={() => setPropTarget({ typeId: selected.id, prop: p })}>
                            Изменить
                          </Button>
                          {p.value_type === "list" && (
                            <Button size="small" onClick={() => setOptionsTarget(p)}>
                              Варианты
                            </Button>
                          )}
                          <Popconfirm
                            title="Удалить свойство?"
                            okText="Удалить"
                            cancelText="Отмена"
                            onConfirm={() => deletePropMutation.mutate(p.id)}
                          >
                            <Button size="small" danger disabled={p.used > 0}>
                              Удалить
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                  },
                ]}
              />
              <TypeRulesPanel type={selected} canManage={canManage} />
            </Space>
          </Card>
        ) : (
          <Card>
            <Empty description="Выберите тип слева или создайте новый" />
          </Card>
        )}
      </Col>

      <Modal
        open={!!newType}
        title="Новый тип"
        okText="Создать"
        cancelText="Отмена"
        onCancel={() => setNewType(null)}
        okButtonProps={{ disabled: !newType?.name.trim(), loading: createTypeMutation.isPending }}
        onOk={() => newType && createTypeMutation.mutate(newType)}
      >
        <Form layout="vertical">
          <Form.Item label="Вид номенклатуры">
            <Select
              value={newType?.kind_code}
              onChange={(v) => setNewType((s) => (s ? { ...s, kind_code: v } : s))}
              options={kinds.map((k) => ({ value: k.code, label: k.name }))}
            />
          </Form.Item>
          <Form.Item label="Название типа">
            <Input
              placeholder="Например: Щитовая дверь"
              value={newType?.name}
              onChange={(e) => setNewType((s) => (s ? { ...s, name: e.target.value } : s))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {propTarget && (
        <PropertyModal
          typeId={propTarget.typeId}
          prop={propTarget.prop}
          onClose={() => setPropTarget(null)}
          onSaved={invalidate}
        />
      )}
      {optionsTarget && <OptionsModal prop={optionsTarget} onClose={() => setOptionsTarget(null)} onSaved={invalidate} />}
    </Row>
  );
}

function PropertyModal({
  typeId,
  prop,
  onClose,
  onSaved,
}: {
  typeId: number;
  prop: ItemProperty | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<PropertyInput>(
    prop
      ? {
          name: prop.name,
          code: prop.code,
          value_type: prop.value_type,
          unit: prop.unit,
          is_required: prop.is_required,
          option_fields: prop.option_fields,
        }
      : { name: "", code: "", value_type: "number", unit: "", is_required: false, option_fields: [] },
  );
  const mutation = useMutation({
    mutationFn: () => (prop ? updateProperty(prop.id, draft) : createProperty(typeId, draft)),
    onSuccess: () => {
      onSaved();
      message.success("Свойство сохранено");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить свойство")),
  });
  const setField = (i: number, patch: Partial<OptionField>) =>
    setDraft((d) => ({ ...d, option_fields: d.option_fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));

  return (
    <Modal
      open
      width={640}
      title={prop ? `Свойство «${prop.name}»` : "Новое свойство"}
      okText="Сохранить"
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ disabled: !draft.name.trim(), loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
    >
      <Form layout="vertical">
        <Space size={12} style={{ display: "flex" }} wrap>
          <Form.Item label="Название" style={{ width: 260 }}>
            <Input value={draft.name} placeholder="Ширина" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Form.Item>
          <Form.Item label="Код (для правил состава)" style={{ width: 200 }} tooltip="Если пусто — из названия">
            <Input value={draft.code ?? ""} placeholder="ширина" onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          </Form.Item>
        </Space>
        <Space size={12} style={{ display: "flex" }} wrap>
          <Form.Item label="Значение" style={{ width: 200 }}>
            <Select
              value={draft.value_type}
              disabled={!!prop && prop.used > 0}
              onChange={(v) => setDraft({ ...draft, value_type: v })}
              options={(Object.keys(PROPERTY_TYPE_LABEL) as (keyof typeof PROPERTY_TYPE_LABEL)[]).map((k) => ({
                value: k,
                label: PROPERTY_TYPE_LABEL[k],
              }))}
            />
          </Form.Item>
          {draft.value_type === "number" && (
            <Form.Item label="Единица" style={{ width: 120 }}>
              <Input value={draft.unit ?? ""} placeholder="мм" onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
            </Form.Item>
          )}
          <Form.Item label=" ">
            <Checkbox checked={draft.is_required} onChange={(e) => setDraft({ ...draft, is_required: e.target.checked })}>
              Обязательное
            </Checkbox>
          </Form.Item>
        </Space>
        {draft.value_type === "list" && (
          <>
            <Typography.Text strong>Параметры вариантов</Typography.Text>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              Необязательно. Например, у серии: толщина каркаса, толщина панели, кромка — их потом используют правила
              состава.
            </Typography.Paragraph>
            <Space direction="vertical" style={{ width: "100%" }}>
              {draft.option_fields.map((f, i) => (
                <Space key={i} wrap>
                  <Input placeholder="Название" value={f.name} style={{ width: 220 }} onChange={(e) => setField(i, { name: e.target.value })} />
                  <Input placeholder="код" value={f.code} style={{ width: 170 }} onChange={(e) => setField(i, { code: e.target.value })} />
                  <Select
                    value={f.value_type}
                    style={{ width: 110 }}
                    onChange={(v) => setField(i, { value_type: v })}
                    options={[
                      { value: "number", label: "Число" },
                      { value: "text", label: "Текст" },
                    ]}
                  />
                  <Button onClick={() => setDraft((d) => ({ ...d, option_fields: d.option_fields.filter((_, j) => j !== i) }))}>
                    Убрать
                  </Button>
                </Space>
              ))}
              <Button
                onClick={() =>
                  setDraft((d) => ({ ...d, option_fields: [...d.option_fields, { code: "", name: "", value_type: "number" }] }))
                }
              >
                + параметр
              </Button>
            </Space>
          </>
        )}
      </Form>
    </Modal>
  );
}

type OptionDraft = { id?: number; value: string; params: Record<string, number | string | null>; is_active: boolean; used: number };

function OptionsModal({ prop, onClose, onSaved }: { prop: ItemProperty; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<OptionDraft[]>(
    prop.options.map((o) => ({ id: o.id, value: o.value, params: { ...o.params }, is_active: o.is_active, used: o.used })),
  );
  const mutation = useMutation({
    mutationFn: () =>
      replacePropertyOptions(
        prop.id,
        rows.map((r) => ({ id: r.id ?? null, value: r.value, params: r.params, is_active: r.is_active })),
      ),
    onSuccess: () => {
      onSaved();
      message.success("Варианты сохранены");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить варианты")),
  });
  const patch = (i: number, p: Partial<OptionDraft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <Modal
      open
      width={Math.min(1100, 520 + prop.option_fields.length * 150)}
      title={`Варианты — ${prop.name}`}
      okText="Сохранить"
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
    >
      <Table<OptionDraft>
        size="small"
        rowKey={(_, i) => String(i)}
        pagination={false}
        dataSource={rows}
        scroll={{ y: 460, x: "max-content" }}
        columns={[
          {
            title: "Вариант",
            render: (_, r, i) => <Input value={r.value} style={{ width: 160 }} onChange={(e) => patch(i, { value: e.target.value })} />,
          },
          ...prop.option_fields.map((f) => ({
            title: f.name,
            key: f.code,
            render: (_: unknown, r: OptionDraft, i: number) =>
              f.value_type === "number" ? (
                <InputNumber
                  value={(r.params[f.code] as number | null | undefined) ?? null}
                  style={{ width: 120 }}
                  onChange={(v) => patch(i, { params: { ...r.params, [f.code]: v } })}
                />
              ) : (
                <Input
                  value={(r.params[f.code] as string | null | undefined) ?? ""}
                  style={{ width: 120 }}
                  onChange={(e) => patch(i, { params: { ...r.params, [f.code]: e.target.value } })}
                />
              ),
          })),
          {
            title: "Активен",
            render: (_, r, i) => <Checkbox checked={r.is_active} onChange={(e) => patch(i, { is_active: e.target.checked })} />,
          },
          {
            title: "",
            render: (_, r, i) =>
              r.used > 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  выбран у {r.used} поз.
                </Typography.Text>
              ) : (
                <Button size="small" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  Убрать
                </Button>
              ),
          },
        ]}
      />
      <Button style={{ marginTop: 8 }} onClick={() => setRows((rs) => [...rs, { value: "", params: {}, is_active: true, used: 0 }])}>
        + вариант
      </Button>
    </Modal>
  );
}

