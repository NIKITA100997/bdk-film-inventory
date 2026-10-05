import { useEffect, useState } from "react";
import { Alert, Button, Divider, Form, Input, InputNumber, Modal, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getItemProperties, listItemTypes, setItemProperties, type PropertyValue } from "../../../api/itemTypes";
import { listAllMaterialSkus, updatePart, type Part, type PartCreate } from "../../../api/dictionaries";
import { listAreas } from "../../../api/areas";
import { skuLabel } from "../../../api/units";
import PropertyInputs from "./PropertyInputs";
import { apiErrorMessage } from "../../../utils/apiError";

/** Правка позиции одним окном (05.10): «Характеристики» — тип и свойства
 * (по ним правила типа пересобирают название, состав и маршрут) и «Учёт и
 * производство» — параметры детали п/ф (штрипс, участок, мин. остаток и
 * партия, закреплённая плёнка). Одна кнопка «Сохранить»: записывается то,
 * что поменяли; техкарта пересчитывается, только если менялись свойства. */
export default function ItemEditModal({
  itemId,
  kindCode,
  typed,
  part,
  canEditTypes,
  canEditPart,
  onClose,
}: {
  itemId: number;
  kindCode: string;
  /** у позиции есть тип — размер для плёнки и название задают правила */
  typed: boolean;
  part: Part | null;
  canEditTypes: boolean;
  canEditPart: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const valuesQuery = useQuery({ queryKey: ["item-properties", itemId], queryFn: () => getItemProperties(itemId) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas, enabled: !!part });
  const skusQuery = useQuery({ queryKey: ["material-skus", "all"], queryFn: listAllMaterialSkus, enabled: !!part });
  const [typeId, setTypeId] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, PropertyValue>>({});
  const [propsDirty, setPropsDirty] = useState(false);
  const [form] = Form.useForm<PartCreate>();

  useEffect(() => {
    if (valuesQuery.data) {
      setTypeId(valuesQuery.data.type_id);
      setValues(valuesQuery.data.values);
    }
  }, [valuesQuery.data]);
  useEffect(() => {
    if (part) {
      form.setFieldsValue({
        name: part.name,
        width_mm: part.width_mm,
        length_m: part.length_m,
        strip_width_mm: part.strip_width_mm ?? undefined,
        area: part.area ?? undefined,
        default_material_sku_id: part.default_material_sku_id ?? undefined,
        min_stock_pieces: part.min_stock_pieces ?? undefined,
        min_batch_pieces: part.min_batch_pieces ?? undefined,
      });
    }
  }, [part, form]);

  const kindTypes = (typesQuery.data ?? []).filter((t) => t.kind_code === kindCode && (t.is_active || t.id === typeId));
  const type = (typesQuery.data ?? []).find((t) => t.id === typeId) ?? null;
  const showProps = canEditTypes && (kindTypes.length > 0 || !!type);
  const showPart = !!part && canEditPart;

  const save = useMutation({
    mutationFn: async () => {
      const notes: string[] = [];
      if (showPart && form.isFieldsTouched()) {
        const v = await form.validateFields();
        const saved = await updatePart(part!.id, {
          ...v,
          area: v.area ?? null,
          default_material_sku_id: v.default_material_sku_id ?? null,
          min_stock_pieces: v.min_stock_pieces ?? null,
          min_batch_pieces: v.min_batch_pieces ?? null,
        });
        if ((saved.synced_task_lines ?? 0) > 0) notes.push(`размер подтянулся в ${saved.synced_task_lines} строк активных заданий`);
      }
      if (showProps && propsDirty) {
        const res = await setItemProperties(itemId, { type_id: typeId, values });
        if (res.rules_errors?.length) notes.push(`техкарта по правилам типа не пересчитана: ${res.rules_errors.join("; ")}`);
      }
      return notes;
    },
    onSuccess: (notes) => {
      for (const k of [["item-properties", itemId], ["item-types"], ["techcard"], ["items"], ["parts"], ["dict-autocomplete", "parts"], ["item-tree"]])
        qc.invalidateQueries({ queryKey: k });
      if (notes.length) message.warning(`Сохранено; ${notes.join("; ")}`, 8);
      else message.success("Сохранено");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });

  const archive = useMutation({
    mutationFn: () => updatePart(part!.id, { is_active: !part!.is_active }),
    onSuccess: () => {
      for (const k of [["parts"], ["dict-autocomplete", "parts"], ["items"], ["techcard"]]) qc.invalidateQueries({ queryKey: k });
      message.success(part!.is_active ? "Деталь в архиве" : "Деталь восстановлена");
      onClose();
    },
  });

  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const skuOptions = (skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }));

  return (
    <Modal
      open
      width={720}
      title="Изменить позицию"
      onCancel={onClose}
      destroyOnHidden
      footer={
        <Space>
          {showPart && (
            <Button danger={part!.is_active} loading={archive.isPending} onClick={() => archive.mutate()}>
              {part!.is_active ? "Деталь в архив" : "Восстановить деталь"}
            </Button>
          )}
          <Button onClick={onClose}>Отмена</Button>
          <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Сохранить
          </Button>
        </Space>
      }
    >
      {showProps && (
        <Form layout="vertical">
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            Характеристики
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
            По ним правила типа собирают название, состав и маршрут — после сохранения техкарта пересчитается.
          </Typography.Paragraph>
          <Form.Item label="Тип">
            <Select
              allowClear
              placeholder="Без типа"
              value={typeId ?? undefined}
              onChange={(v) => {
                setTypeId(v ?? null);
                if (v !== typeId) setValues({});
                setPropsDirty(true);
              }}
              options={kindTypes.map((t) => ({ value: t.id, label: t.name }))}
            />
          </Form.Item>
          {type && (
            <PropertyInputs
              type={type}
              values={values}
              onChange={(v) => {
                setValues(v);
                setPropsDirty(true);
              }}
            />
          )}
        </Form>
      )}
      {showProps && showPart && <Divider />}
      {showPart && (
        <Form layout="vertical" form={form}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            Учёт и производство
          </Typography.Title>
          {!typed && (
            <>
              <Form.Item name="name" label="Название" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Space size={12} style={{ display: "flex" }}>
                <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]} style={{ flex: 1 }}>
                  <InputNumber min={1} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item name="length_m" label="Длина на списание, м" rules={[{ required: true }]} style={{ flex: 1 }}>
                  <InputNumber min={0.01} step={0.1} style={{ width: "100%" }} />
                </Form.Item>
              </Space>
            </>
          )}
          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item name="strip_width_mm" label="Ширина штрипса плёнки, мм" style={{ flex: 1 }}>
              <InputNumber min={1} style={{ width: "100%" }} placeholder="по ширине детали" />
            </Form.Item>
            <Form.Item name="area" label="Участок" style={{ flex: 1 }}>
              <Select allowClear options={areaOptions} placeholder="общая для всех участков" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: "flex" }}>
            <Form.Item name="min_stock_pieces" label="Мин. остаток, шт" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: "100%" }} placeholder="не задан" />
            </Form.Item>
            <Form.Item name="min_batch_pieces" label="Мин. партия производства, шт" style={{ flex: 1 }}>
              <InputNumber min={1} style={{ width: "100%" }} placeholder="не задана" />
            </Form.Item>
          </Space>
          <Form.Item
            name="default_material_sku_id"
            label="Закреплённая плёнка"
            extra="Подставляется в задания вместо подбора по цвету."
          >
            <Select
              allowClear
              showSearch
              loading={skusQuery.isLoading}
              options={skuOptions}
              placeholder="не закреплена — подбор по цвету"
              optionFilterProp="label"
            />
          </Form.Item>
        </Form>
      )}
      {!showProps && !showPart && <Alert type="info" showIcon message="Править здесь нечего — у вас нет прав или у вида нет типов." />}
    </Modal>
  );
}
