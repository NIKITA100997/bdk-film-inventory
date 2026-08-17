import { useEffect, useState } from "react";
import { Card, Tabs, Typography, InputNumber, Select, Switch, Segmented, Button, Space, List, Tag, Modal, Alert, message } from "antd";
import { HolderOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  getLabelTemplate,
  listAvailableLabelFields,
  updateLabelTemplate,
  previewLabelTemplate,
  type LabelFieldConfig,
  type FieldSize,
  type AvailableField,
  type LabelKind,
} from "../../api/labels";

const sizeOptions: { value: FieldSize; label: string }[] = [
  { value: "sm", label: "Мелкий" },
  { value: "md", label: "Средний" },
  { value: "lg", label: "Крупный" },
];

function SortableFieldItem({
  field,
  meta,
  onRemove,
  onSizeChange,
  onBoldChange,
}: {
  field: LabelFieldConfig;
  meta?: AvailableField;
  onRemove: () => void;
  onSizeChange: (v: FieldSize) => void;
  onBoldChange: (v: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.key });
  const isText = meta?.kind === "text";

  return (
    <List.Item
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, background: "#fff" }}
      actions={[
        <Button key="remove" size="small" danger onClick={onRemove}>
          Убрать
        </Button>,
      ]}
    >
      <Space>
        <span {...attributes} {...listeners} style={{ cursor: "grab", touchAction: "none", color: "rgba(0,0,0,0.45)" }}>
          <HolderOutlined />
        </span>
        <span>{meta?.label ?? field.key}</span>
        {meta?.stale_warning && <Tag color="orange">теряет актуальность</Tag>}
        {isText && (
          <Select size="small" style={{ width: 110 }} value={field.size} options={sizeOptions} onChange={onSizeChange} />
        )}
        {isText && (
          <Space size={4}>
            <Switch size="small" checked={field.bold} onChange={onBoldChange} />
            <Typography.Text type="secondary">жирный</Typography.Text>
          </Space>
        )}
      </Space>
    </List.Item>
  );
}

const KIND_DEFAULTS: Record<LabelKind, { width: number; height: number }> = {
  unit: { width: 100, height: 40 },
  rack: { width: 70, height: 40 },
  shelf: { width: 70, height: 40 },
};

function LabelTemplateEditor({ kind }: { kind: LabelKind }) {
  const qc = useQueryClient();
  const templateQuery = useQuery({ queryKey: ["label-template", kind], queryFn: () => getLabelTemplate(kind) });
  const fieldsQuery = useQuery({ queryKey: ["label-template", "available-fields", kind], queryFn: () => listAvailableLabelFields(kind) });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const [widthMm, setWidthMm] = useState(KIND_DEFAULTS[kind].width);
  const [heightMm, setHeightMm] = useState(KIND_DEFAULTS[kind].height);
  const [fields, setFields] = useState<LabelFieldConfig[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (templateQuery.data && !loaded) {
      // Старый singleton-макет рулона мог остаться со старым дефолтом
      // 60×90 (до перехода на 100×40 landscape) — актуально только для
      // kind="unit", у стеллажного макета такой истории нет.
      const isLegacyUnitDefault = kind === "unit" && templateQuery.data.width_mm === 60 && templateQuery.data.height_mm === 90;
      setWidthMm(isLegacyUnitDefault ? 100 : templateQuery.data.width_mm);
      setHeightMm(isLegacyUnitDefault ? 40 : templateQuery.data.height_mm);
      setFields(templateQuery.data.fields);
      setLoaded(true);
    }
  }, [templateQuery.data, loaded, kind]);

  const fieldMeta = (key: string) => fieldsQuery.data?.find((f) => f.key === key);
  const availableToAdd = (fieldsQuery.data ?? []).filter((f) => !fields.some((used) => used.key === f.key));

  const saveMutation = useMutation({
    mutationFn: () => updateLabelTemplate({ width_mm: widthMm, height_mm: heightMm, fields }, kind),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["label-template", kind] });
      message.success("Макет сохранён");
    },
    onError: () => message.error("Не удалось сохранить макет"),
  });

  // Превью и тестовая печать — теперь одно действие: открывает настоящий PDF
  // в новой вкладке (родной просмотрщик браузера, печать — его собственной
  // кнопкой), тем же путём, что подтверждённо надёжно печатает даже на
  // капризных термопринтерах (раздел обратной связи про Codex G500).
  const previewMutation = useMutation({
    mutationFn: () => previewLabelTemplate({ width_mm: widthMm, height_mm: heightMm, fields }, kind),
  });

  const addField = (key: string) => {
    const meta = fieldMeta(key);
    const doAdd = () => setFields((f) => [...f, { key, size: "sm", bold: false }]);
    if (meta?.stale_warning) {
      Modal.confirm({
        title: "Поле потеряет актуальность",
        content:
          "Ширина/длина меняются при каждом разделении и резке, а этикетка не перепечатывается. Значение на бирке разойдётся с фактическим — сверяйте по ID/QR в приложении.",
        okText: "Добавить всё равно",
        cancelText: "Отмена",
        onOk: doAdd,
      });
    } else {
      doAdd();
    }
  };

  const removeField = (index: number) => setFields((f) => f.filter((_, i) => i !== index));
  const updateField = (index: number, patch: Partial<LabelFieldConfig>) =>
    setFields((f) => f.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setFields((f) => {
      const oldIndex = f.findIndex((x) => x.key === active.id);
      const newIndex = f.findIndex((x) => x.key === over.id);
      return arrayMove(f, oldIndex, newIndex);
    });
  };

  return (
    <Card loading={templateQuery.isLoading || fieldsQuery.isLoading}>
      <Typography.Paragraph type="secondary">
        Перетащите поля за {"⠿"}, чтобы изменить порядок — так они лягут на бирку сверху вниз.
        {kind === "unit" && " Ширина и длина по умолчанию не печатаются (4.1 ТЗ): они меняются при каждом разделении, а этикетка не перепечатывается."}
      </Typography.Paragraph>

      <Space size="large" style={{ marginBottom: 20 }} align="center">
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">Ширина этикетки, мм</Typography.Text>
          <InputNumber min={20} max={200} value={widthMm} onChange={(v) => setWidthMm(v ?? KIND_DEFAULTS[kind].width)} />
        </Space>
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">Высота этикетки, мм</Typography.Text>
          <InputNumber min={20} max={200} value={heightMm} onChange={(v) => setHeightMm(v ?? KIND_DEFAULTS[kind].height)} />
        </Space>
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">Ориентация</Typography.Text>
          <Segmented
            value={widthMm >= heightMm ? "landscape" : "portrait"}
            onChange={(v) => {
              const wantLandscape = v === "landscape";
              if (wantLandscape !== widthMm >= heightMm) {
                setWidthMm(heightMm);
                setHeightMm(widthMm);
              }
            }}
            options={[
              { label: "Горизонтальная", value: "landscape" },
              { label: "Вертикальная", value: "portrait" },
            ]}
          />
        </Space>
        {widthMm > heightMm && (
          <Alert
            type="info"
            showIcon
            message={`Горизонтальный макет ${widthMm}×${heightMm} мм`}
            description="QR-код автоматически размещается слева, а текстовая информация — справа."
            style={{ margin: 0 }}
          />
        )}
      </Space>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={fields.map((f) => f.key)} strategy={verticalListSortingStrategy}>
          <List
            bordered
            dataSource={fields}
            locale={{ emptyText: "Полей нет — этикетка будет пустой" }}
            renderItem={(field, index) => (
              <SortableFieldItem
                key={field.key}
                field={field}
                meta={fieldMeta(field.key)}
                onRemove={() => removeField(index)}
                onSizeChange={(v) => updateField(index, { size: v })}
                onBoldChange={(v) => updateField(index, { bold: v })}
              />
            )}
          />
        </SortableContext>
      </DndContext>

      <Space style={{ marginTop: 16 }}>
        <Select
          style={{ width: 260 }}
          placeholder="Добавить поле"
          value={null}
          options={availableToAdd.map((f) => ({ value: f.key, label: f.label }))}
          onChange={(v) => v && addField(v)}
        />
      </Space>

      <Space style={{ marginTop: 24 }}>
        <Button type="primary" loading={previewMutation.isPending} onClick={() => previewMutation.mutate()}>
          Открыть PDF / печать
        </Button>
        <Button loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          Сохранить макет
        </Button>
      </Space>
    </Card>
  );
}

/** Макет этикетки (4 раздел бэклога доработок, расширено разделом про
 * макеты для стеллажей/полок) — один и тот же редактор полей на три
 * независимых макета: рулоны/штрипсы плёнки, стеллаж целиком и отдельное
 * место хранения (полка/ячейка), переключаются вкладками, каждый свой
 * набор полей и свой размер этикетки по умолчанию. */
export default function LabelTemplateAdmin() {
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={4}>Макет этикетки</Typography.Title>
      <Tabs
        items={[
          { key: "unit", label: "Рулоны плёнки", children: <LabelTemplateEditor kind="unit" /> },
          { key: "rack", label: "Стеллаж (целиком)", children: <LabelTemplateEditor kind="rack" /> },
          { key: "shelf", label: "Полка / ячейка", children: <LabelTemplateEditor kind="shelf" /> },
        ]}
      />
    </Space>
  );
}
