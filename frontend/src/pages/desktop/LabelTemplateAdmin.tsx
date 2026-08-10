import { useEffect, useState } from "react";
import { Card, Typography, InputNumber, Select, Switch, Button, Space, List, Tag, Modal, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getLabelTemplate,
  listAvailableLabelFields,
  updateLabelTemplate,
  previewLabelTemplate,
  type LabelFieldConfig,
  type FieldSize,
} from "../../api/labels";

const sizeOptions: { value: FieldSize; label: string }[] = [
  { value: "sm", label: "Мелкий" },
  { value: "md", label: "Средний" },
  { value: "lg", label: "Крупный" },
];

export default function LabelTemplateAdmin() {
  const qc = useQueryClient();
  const templateQuery = useQuery({ queryKey: ["label-template"], queryFn: getLabelTemplate });
  const fieldsQuery = useQuery({ queryKey: ["label-template", "available-fields"], queryFn: listAvailableLabelFields });

  const [widthMm, setWidthMm] = useState(60);
  const [heightMm, setHeightMm] = useState(90);
  const [fields, setFields] = useState<LabelFieldConfig[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (templateQuery.data && !loaded) {
      setWidthMm(templateQuery.data.width_mm);
      setHeightMm(templateQuery.data.height_mm);
      setFields(templateQuery.data.fields);
      setLoaded(true);
    }
  }, [templateQuery.data, loaded]);

  const fieldMeta = (key: string) => fieldsQuery.data?.find((f) => f.key === key);
  const availableToAdd = (fieldsQuery.data ?? []).filter((f) => !fields.some((used) => used.key === f.key));

  const saveMutation = useMutation({
    mutationFn: () => updateLabelTemplate({ width_mm: widthMm, height_mm: heightMm, fields }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["label-template"] });
      message.success("Макет сохранён");
    },
    onError: () => message.error("Не удалось сохранить макет"),
  });

  const previewMutation = useMutation({
    mutationFn: () => previewLabelTemplate({ width_mm: widthMm, height_mm: heightMm, fields }),
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
  const moveField = (index: number, dir: -1 | 1) => {
    setFields((f) => {
      const next = [...f];
      const target = index + dir;
      if (target < 0 || target >= next.length) return f;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const updateField = (index: number, patch: Partial<LabelFieldConfig>) =>
    setFields((f) => f.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  return (
    <Card loading={templateQuery.isLoading || fieldsQuery.isLoading}>
      <Typography.Title level={4}>Макет этикетки</Typography.Title>
      <Typography.Paragraph type="secondary">
        Список полей сверху вниз — так они лягут на бирку. Ширина и длина по умолчанию не печатаются (4.1 ТЗ):
        они меняются при каждом разделении, а этикетка не перепечатывается.
      </Typography.Paragraph>

      <Space size="large" style={{ marginBottom: 20 }}>
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">Ширина этикетки, мм</Typography.Text>
          <InputNumber min={20} max={200} value={widthMm} onChange={(v) => setWidthMm(v ?? 60)} />
        </Space>
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">Высота этикетки, мм</Typography.Text>
          <InputNumber min={20} max={200} value={heightMm} onChange={(v) => setHeightMm(v ?? 90)} />
        </Space>
      </Space>

      <List
        bordered
        dataSource={fields}
        locale={{ emptyText: "Полей нет — этикетка будет пустой" }}
        renderItem={(field, index) => {
          const meta = fieldMeta(field.key);
          const isText = meta?.kind === "text";
          return (
            <List.Item
              actions={[
                <Button key="up" size="small" disabled={index === 0} onClick={() => moveField(index, -1)}>
                  Вверх
                </Button>,
                <Button key="down" size="small" disabled={index === fields.length - 1} onClick={() => moveField(index, 1)}>
                  Вниз
                </Button>,
                <Button key="remove" size="small" danger onClick={() => removeField(index)}>
                  Убрать
                </Button>,
              ]}
            >
              <Space>
                <span>{meta?.label ?? field.key}</span>
                {meta?.stale_warning && <Tag color="orange">теряет актуальность</Tag>}
                {isText && (
                  <Select
                    size="small"
                    style={{ width: 110 }}
                    value={field.size}
                    options={sizeOptions}
                    onChange={(v) => updateField(index, { size: v })}
                  />
                )}
                {isText && (
                  <Space size={4}>
                    <Switch size="small" checked={field.bold} onChange={(v) => updateField(index, { bold: v })} />
                    <Typography.Text type="secondary">жирный</Typography.Text>
                  </Space>
                )}
              </Space>
            </List.Item>
          );
        }}
      />

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
        <Button loading={previewMutation.isPending} onClick={() => previewMutation.mutate()}>
          Превью
        </Button>
        <Button type="primary" loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          Сохранить макет
        </Button>
      </Space>
    </Card>
  );
}
