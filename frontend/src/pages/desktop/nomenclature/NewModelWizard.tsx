import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isFilmColorProperty, listItemTypes, type ItemProperty, type ItemType, type PropertyValue } from "../../../api/itemTypes";
import NewFilmColorButton from "../../../components/NewFilmColorButton";
import { createModel, getTypeHints, previewTree, variantsBatch, type Hint, type VariantRow } from "../../../api/modelBuilder";
import TechTree from "../../../components/TechTree";
import { optionLabel } from "../../../utils/optionLabel";
import { apiErrorMessage } from "../../../utils/apiError";

const STATUS: Record<string, { color: string; label: string }> = {
  new: { color: "green", label: "новая" },
  exists: { color: "default", label: "уже есть" },
  error: { color: "red", label: "ошибка" },
  created: { color: "green", label: "создана" },
};

type Choices = Record<number, PropertyValue[]>;

/** Новая модель с подсказками: тип → модель (серия и её параметры) →
 * варианты (размеры, цвета… — всё со всем) → схема техкарты и создание.
 * Подсказки — частые значения из уже заведённого по типу; схема — как
 * mindmap, до создания, с пометкой того, что заведётся. typeId/optionId —
 * «добавить варианты» к существующей модели (сразу шаг вариантов). */
export default function NewModelWizard({
  onClose,
  typeId: presetType,
  optionId: presetOption,
}: {
  onClose: () => void;
  typeId?: number;
  optionId?: number;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const [typeId, setTypeId] = useState<number | undefined>(presetType);
  const type = typesQuery.data?.find((t) => t.id === typeId);
  const modelProp = type?.properties.find((p) => p.code === type.model_property_code) ?? null;
  const hintsQuery = useQuery({ queryKey: ["type-hints", typeId], queryFn: () => getTypeHints(typeId as number), enabled: !!typeId });
  const hints = hintsQuery.data;

  const [step, setStep] = useState(presetType ? (presetOption ? 2 : 1) : 0);
  const [optionId, setOptionId] = useState<number | undefined>(presetOption);
  const [choices, setChoices] = useState<Choices>({});

  // Значения по умолчанию на шаге вариантов: список — самый частый вариант,
  // да/нет — «нет». Серия — выбранная модель.
  useEffect(() => {
    if (!type || !hints) return;
    setChoices((prev) => {
      const next: Choices = { ...prev };
      for (const p of type.properties) {
        if (p.id === modelProp?.id || next[p.id]?.length) continue;
        if (p.value_type === "bool") next[p.id] = [false];
        else if (p.value_type === "list" && p.is_required && !isFilmColorProperty(p)) {
          const top = hints.properties[p.id]?.[0]?.value;
          next[p.id] = top != null ? [top] : [];
        }
      }
      return next;
    });
  }, [type, hints, modelProp?.id]);

  const fullChoices = useMemo(
    () => (modelProp && optionId ? { ...choices, [modelProp.id]: [optionId] } : choices),
    [choices, modelProp, optionId],
  );
  const missing = (type?.properties ?? []).filter(
    (p) => p.is_required && p.value_type !== "bool" && !(fullChoices[p.id]?.length ?? 0),
  );
  const combos = (type?.properties ?? []).reduce((n, p) => n * Math.max(1, fullChoices[p.id]?.length ?? 0), 1);

  const previewQuery = useQuery({
    queryKey: ["variants-preview", typeId, fullChoices],
    queryFn: () => variantsBatch(typeId as number, fullChoices, false),
    enabled: !!typeId && step >= 2 && missing.length === 0,
  });
  const rows = previewQuery.data?.rows ?? [];
  const newRows = rows.filter((r) => r.status === "new");
  const [treeRow, setTreeRow] = useState(0);
  const sample = newRows[treeRow] ?? newRows[0] ?? rows[0];
  const treeQuery = useQuery({
    queryKey: ["tree-preview", typeId, sample?.values],
    queryFn: () => previewTree(typeId as number, sample!.values),
    enabled: !!typeId && step === 3 && !!sample,
  });

  const createMutation = useMutation({
    mutationFn: () => variantsBatch(typeId as number, fullChoices, true),
    onSuccess: (res) => {
      for (const key of [["items"], ["item-types"], ["type-hints"], ["variants-preview"]]) qc.invalidateQueries({ queryKey: key });
      const created = res.rows.filter((r) => r.status === "created");
      const failed = res.rows.filter((r) => r.status === "error");
      if (failed.length) message.warning(`Создано: ${created.length}, с ошибками: ${failed.length} — смотрите таблицу`);
      else message.success(`Создано вариантов: ${created.length}`);
      if (!failed.length) {
        onClose();
        const first = created[0] ?? res.rows[0];
        if (first?.item_id) navigate(`/item/${first.item_id}`);
      }
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать варианты")),
  });

  const steps = [
    { title: "Тип" },
    { title: "Модель", disabled: !modelProp },
    { title: "Варианты" },
    { title: "Схема и создание" },
  ];

  return (
    <Modal
      open
      width="95vw"
      style={{ maxWidth: 1300, top: 16 }}
      title="Новая модель"
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          {step > 0 && (
            <Button onClick={() => setStep((s) => (s === 2 && !modelProp ? 0 : s - 1))} disabled={!!presetOption && step === 2}>
              Назад
            </Button>
          )}
          {step === 2 && (
            <Button type="primary" disabled={missing.length > 0 || newRows.length === 0} onClick={() => setStep(3)}>
              Дальше: схема
            </Button>
          )}
          {step === 3 && (
            <Button
              type="primary"
              disabled={newRows.length === 0}
              loading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Создать вариантов: {newRows.length}
            </Button>
          )}
        </Space>
      }
    >
      <Steps size="small" current={step} items={steps} style={{ marginBottom: 20 }} />
      {typesQuery.isLoading && <Spin />}

      {step === 0 && (
        <TypeStep
          types={typesQuery.data ?? []}
          onPick={(t) => {
            setTypeId(t.id);
            setOptionId(undefined);
            setChoices({});
            setStep(t.model_property_code ? 1 : 2);
          }}
        />
      )}

      {step === 1 && type && modelProp && (
        <ModelStep
          type={type}
          modelProp={modelProp}
          fieldHints={hints?.option_fields[modelProp.id] ?? {}}
          onDone={(id) => {
            setOptionId(id);
            setStep(2);
          }}
        />
      )}

      {step === 2 && type && (
        <Row gutter={24}>
          <Col xs={24} lg={11}>
            <VariantChoices type={type} modelProp={modelProp} hints={hints?.properties ?? {}} choices={choices} onChange={setChoices} />
          </Col>
          <Col xs={24} lg={13}>
            <Space direction="vertical" style={{ width: "100%" }}>
              {missing.length > 0 ? (
                <Alert type="info" showIcon message={`Выберите: ${missing.map((p) => p.name).join(", ")}`} />
              ) : (
                <Typography.Text>
                  Сочетаний: <b>{combos}</b>
                  {previewQuery.data && (
                    <>
                      {" "}
                      · новых <b>{newRows.length}</b> · уже есть {rows.filter((r) => r.status === "exists").length} · с ошибками{" "}
                      {rows.filter((r) => r.status === "error").length}
                    </>
                  )}
                  {previewQuery.data?.truncated && <Tag color="orange" style={{ marginLeft: 8 }}>показаны первые 300</Tag>}
                </Typography.Text>
              )}
              <VariantsTable rows={rows} loading={previewQuery.isFetching} />
            </Space>
          </Col>
        </Row>
      )}

      {step === 3 && type && (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Space wrap>
            <Typography.Text>Схема варианта:</Typography.Text>
            <Select
              style={{ minWidth: 420 }}
              value={Math.min(treeRow, Math.max(0, newRows.length - 1))}
              onChange={setTreeRow}
              options={newRows.map((r, i) => ({ value: i, label: r.name ?? `вариант ${i + 1}` }))}
            />
            <Typography.Text type="secondary">
              Пунктир — позиция заведётся при создании. Клик по блоку — свернуть/развернуть.
            </Typography.Text>
          </Space>
          {treeQuery.isLoading ? <Spin /> : treeQuery.data ? <TechTree root={treeQuery.data} expandDepth={3} /> : <Empty />}
          {createMutation.data && <VariantsTable rows={createMutation.data.rows} loading={false} />}
        </Space>
      )}
    </Modal>
  );
}

function TypeStep({ types, onPick }: { types: ItemType[]; onPick: (t: ItemType) => void }) {
  const usable = types
    .filter((t) => t.is_active && t.name_template)
    .sort((a, b) => (a.kind_code === "izdelie" ? 0 : 1) - (b.kind_code === "izdelie" ? 0 : 1) || a.name.localeCompare(b.name, "ru"));
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        Что делаем? Тип задаёт свойства, маршрут по участкам и состав — у новой модели всё это будет сразу. Нужного
        типа нет — заведите его в «Типы и правила» (можно начать с копии похожего).
      </Typography.Text>
      <Row gutter={[12, 12]}>
        {usable.map((t) => (
          <Col key={t.id} xs={24} sm={12} lg={8}>
            <Card size="small" hoverable onClick={() => onPick(t)} style={{ height: "100%" }}>
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Space wrap>
                  <b>{t.name}</b>
                  <Tag>{t.kind_name}</Tag>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.model_property_code ? `моделей ${t.model_count} · ` : ""}позиций {t.item_count}
                </Typography.Text>
                {t.operations.length > 0 ? (
                  <Typography.Text style={{ fontSize: 12 }}>{t.operations.map((o) => o.name).join(" → ")}</Typography.Text>
                ) : (
                  <Tag color="orange">нет маршрута — в заказ не запустится</Tag>
                )}
                {t.component_rules.length > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    состав по правилам: {t.component_rules.length}
                  </Typography.Text>
                )}
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
    </Space>
  );
}

function HintChips({ hints, label, onPick }: { hints: Hint[]; label?: (v: PropertyValue) => string; onPick: (v: PropertyValue) => void }) {
  if (!hints.length) return null;
  return (
    <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        часто:
      </Typography.Text>
      {hints.map((h) => (
        <Tag key={String(h.value)} style={{ cursor: "pointer", margin: 0 }} onClick={() => onPick(h.value)}>
          {label ? label(h.value) : String(h.value)} <Typography.Text type="secondary">×{h.count}</Typography.Text>
        </Tag>
      ))}
    </Space>
  );
}

function ModelStep({
  type,
  modelProp,
  fieldHints,
  onDone,
}: {
  type: ItemType;
  modelProp: ItemProperty;
  fieldHints: Record<string, Hint[]>;
  onDone: (optionId: number) => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [existing, setExisting] = useState<number | undefined>();
  const [name, setName] = useState("");
  const [params, setParams] = useState<Record<string, number | string | null>>(() =>
    Object.fromEntries(modelProp.option_fields.map((f) => [f.code, (fieldHints[f.code]?.[0]?.value as number | string | undefined) ?? null])),
  );
  const options = modelProp.options.filter((o) => o.is_active);
  const nameTaken = options.some((o) => o.value.trim().toLowerCase() === name.trim().toLowerCase());
  const createMutation = useMutation({
    mutationFn: () => createModel(type.id, { value: name, params }),
    onSuccess: (res) => {
      for (const key of [["item-types"], ["items"], ["type-hints"]]) qc.invalidateQueries({ queryKey: key });
      message.success(`Модель «${res.name}» создана — теперь её варианты`);
      onDone(res.option_id);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать модель")),
  });

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      <Segmented
        value={mode}
        onChange={(v) => setMode(v as "new" | "existing")}
        options={[
          { label: "Новая модель", value: "new" },
          { label: "Добавить варианты к существующей", value: "existing" },
        ]}
      />
      {mode === "existing" ? (
        <Space wrap>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 360 }}
            placeholder={`${modelProp.name}…`}
            value={existing}
            onChange={setExisting}
            options={options.map((o) => ({ value: o.id, label: `${optionLabel(o)}${o.used ? ` (вариантов: ${o.used})` : ""}` }))}
          />
          <Button type="primary" disabled={!existing} onClick={() => existing && onDone(existing)}>
            Дальше: варианты
          </Button>
        </Space>
      ) : (
        <Row gutter={24}>
          <Col xs={24} md={12}>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Typography.Text strong>
                {modelProp.name} — название модели
              </Typography.Text>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, В-11" status={nameTaken ? "error" : undefined} />
              {nameTaken ? (
                <Typography.Text type="danger">Такая модель уже есть — выберите «Добавить варианты к существующей»</Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Как названы сейчас: {options.slice(-10).map((o) => o.value).join(", ") || "—"}
                </Typography.Text>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Позиция-модель будет называться «{type.name} {name || "…"}».
              </Typography.Text>
            </Space>
          </Col>
          <Col xs={24} md={12}>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space wrap>
                <Typography.Text strong>Параметры модели</Typography.Text>
                <Select
                  size="small"
                  showSearch
                  optionFilterProp="label"
                  style={{ width: 220 }}
                  placeholder="как у модели…"
                  onChange={(id: number) => {
                    const o = options.find((x) => x.id === id);
                    if (o) setParams((prev) => ({ ...prev, ...o.params }));
                  }}
                  options={options.map((o) => ({ value: o.id, label: optionLabel(o) }))}
                />
              </Space>
              {modelProp.option_fields.map((f) => (
                <div key={f.code}>
                  <Typography.Text>{f.name}</Typography.Text>
                  <div>
                    {f.value_type === "number" ? (
                      <InputNumber
                        style={{ width: 200 }}
                        value={(params[f.code] as number | null) ?? null}
                        onChange={(v) => setParams((prev) => ({ ...prev, [f.code]: v }))}
                      />
                    ) : (
                      <Input
                        style={{ width: 200 }}
                        value={(params[f.code] as string | null) ?? ""}
                        onChange={(e) => setParams((prev) => ({ ...prev, [f.code]: e.target.value }))}
                      />
                    )}
                  </div>
                  <HintChips hints={fieldHints[f.code] ?? []} onPick={(v) => setParams((prev) => ({ ...prev, [f.code]: v as number | string }))} />
                </div>
              ))}
              {modelProp.option_fields.length === 0 && <Typography.Text type="secondary">Параметров у модели нет.</Typography.Text>}
            </Space>
          </Col>
          <Col span={24} style={{ marginTop: 16 }}>
            <Button
              type="primary"
              disabled={!name.trim() || nameTaken || modelProp.option_fields.some((f) => params[f.code] == null || params[f.code] === "")}
              loading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Создать модель и перейти к вариантам
            </Button>
          </Col>
        </Row>
      )}
    </Space>
  );
}

function VariantChoices({
  type,
  modelProp,
  hints,
  choices,
  onChange,
}: {
  type: ItemType;
  modelProp: ItemProperty | null;
  hints: Record<number, Hint[]>;
  choices: Choices;
  onChange: (c: Choices) => void;
}) {
  const set = (pid: number, vals: PropertyValue[]) => onChange({ ...choices, [pid]: vals });
  const add = (pid: number, v: PropertyValue) => {
    const cur = choices[pid] ?? [];
    if (!cur.some((x) => x === v)) set(pid, [...cur, v]);
  };
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={14}>
      <Typography.Text type="secondary">
        Выберите значения — сделаю варианты «всё со всем». Можно несколько размеров и цветов сразу; подсказки — что
        чаще всего уже заведено у этого типа.
      </Typography.Text>
      {type.properties
        .filter((p) => p.id !== modelProp?.id)
        .map((p) => {
          const vals = choices[p.id] ?? [];
          const hint = hints[p.id] ?? [];
          const optLabel = (v: PropertyValue) => (p.options.find((o) => o.id === v) ? optionLabel(p.options.find((o) => o.id === v)) : String(v));
          return (
            <div key={p.id} data-prop={p.code}>
              <Typography.Text strong>
                {p.name}
                {p.unit ? `, ${p.unit}` : ""}
                {p.is_required && p.value_type !== "bool" && <Typography.Text type="danger"> *</Typography.Text>}
              </Typography.Text>
              <div style={{ marginTop: 4 }}>
                {p.value_type === "bool" ? (
                  <Checkbox.Group
                    value={vals as boolean[]}
                    onChange={(v) => set(p.id, v as boolean[])}
                    options={[
                      { label: "нет", value: false },
                      { label: "да", value: true },
                    ]}
                  />
                ) : p.value_type === "list" ? (
                  <>
                    <Select
                      mode="multiple"
                      showSearch
                      optionFilterProp="label"
                      style={{ width: "100%" }}
                      value={vals as number[]}
                      onChange={(v) => set(p.id, v)}
                      options={p.options.filter((o) => o.is_active).map((o) => ({ value: o.id, label: optionLabel(o) }))}
                      placeholder="Выберите"
                    />
                    {isFilmColorProperty(p) && <NewFilmColorButton property={p} onCreated={(id) => add(p.id, id)} />}
                  </>
                ) : (
                  <Select
                    mode="tags"
                    style={{ width: "100%" }}
                    value={vals.map(String)}
                    onChange={(v: string[]) =>
                      set(
                        p.id,
                        p.value_type === "number"
                          ? v.map((x) => Number(x.replace(",", "."))).filter((x) => !Number.isNaN(x))
                          : v.map((x) => x.trim()).filter(Boolean),
                      )
                    }
                    options={hint.map((h) => ({ value: String(h.value), label: `${h.value} (×${h.count})` }))}
                    placeholder={p.value_type === "number" ? "Введите число и Enter" : "Введите и Enter"}
                    tokenSeparators={p.value_type === "number" ? [";", " "] : [";"]}
                  />
                )}
              </div>
              {p.value_type !== "bool" && (
                <HintChips hints={hint.filter((h) => !vals.includes(h.value))} label={p.value_type === "list" ? optLabel : undefined} onPick={(v) => add(p.id, v)} />
              )}
            </div>
          );
        })}
    </Space>
  );
}

function VariantsTable({ rows, loading }: { rows: VariantRow[]; loading: boolean }) {
  return (
    <Table<VariantRow>
      size="small"
      rowKey={(r, i) => `${r.name}-${i}`}
      loading={loading}
      dataSource={rows}
      pagination={{ pageSize: 15, hideOnSinglePage: true }}
      locale={{ emptyText: "Выберите значения слева" }}
      columns={[
        {
          title: "Вариант",
          render: (_, r) => (
            <Space direction="vertical" size={0}>
              <span>{r.name ?? "—"}</span>
              {r.errors.map((e) => (
                <Typography.Text key={e} type="danger" style={{ fontSize: 12 }}>
                  {e}
                </Typography.Text>
              ))}
            </Space>
          ),
        },
        { title: "", width: 100, render: (_, r) => <Tag color={STATUS[r.status].color}>{STATUS[r.status].label}</Tag> },
      ]}
    />
  );
}
