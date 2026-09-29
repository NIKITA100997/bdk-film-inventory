import { useEffect } from "react";
import { Button, Form, Input, InputNumber, Modal, Select, Space, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPart, listAllMaterialSkus, updatePart, type Part, type PartCreate } from "../../../api/dictionaries";
import { listAreas } from "../../../api/areas";
import { skuLabel } from "../../../api/units";

/** Параметры детали п/ф (бывшая вкладка «Детали п/ф»): размеры для
 * списания плёнки, ширина штрипса, участок, закреплённая плёнка, мин.
 * остаток и мин. партия. part = null — новая деталь. */
export default function PartParamsModal({ part, onClose }: { part: Part | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<PartCreate>();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const skusQuery = useQuery({ queryKey: ["material-skus", "all"], queryFn: listAllMaterialSkus });
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const skuOptions = (skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }));

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

  const invalidate = () => {
    for (const k of [["parts"], ["dict-autocomplete", "parts"], ["items"], ["techcard"]]) qc.invalidateQueries({ queryKey: k });
  };
  const save = useMutation({
    mutationFn: (v: PartCreate) =>
      part
        ? updatePart(part.id, {
            ...v,
            area: v.area ?? null,
            default_material_sku_id: v.default_material_sku_id ?? null,
            min_stock_pieces: v.min_stock_pieces ?? null,
            min_batch_pieces: v.min_batch_pieces ?? null,
          })
        : createPart(v),
    onSuccess: (saved) => {
      invalidate();
      const synced = saved.synced_task_lines ?? 0;
      message.success(
        part ? (synced > 0 ? `Деталь обновлена — размер подтянулся в ${synced} строк активных заданий` : "Деталь обновлена") : "Деталь добавлена",
      );
      onClose();
    },
    onError: () => message.error("Не удалось сохранить — название уже занято?"),
  });
  const archive = useMutation({
    mutationFn: () => updatePart(part!.id, { is_active: !part!.is_active }),
    onSuccess: () => {
      invalidate();
      message.success(part!.is_active ? "Деталь в архиве" : "Деталь восстановлена");
      onClose();
    },
  });

  return (
    <Modal
      open
      title={part ? `Параметры детали «${part.name}»` : "Новая деталь п/ф"}
      onCancel={onClose}
      footer={
        <Space>
          {part && (
            <Button danger={part.is_active} loading={archive.isPending} onClick={() => archive.mutate()}>
              {part.is_active ? "В архив" : "Восстановить"}
            </Button>
          )}
          <Button onClick={onClose}>Отмена</Button>
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            {part ? "Сохранить" : "Добавить деталь"}
          </Button>
        </Space>
      }
      destroyOnHidden
    >
      <Form layout="vertical" form={form} onFinish={(v) => save.mutate(v)}>
        <Form.Item name="name" label="Название" rules={[{ required: true }]}>
          <Input placeholder="Наличник 8х70х2150" autoFocus />
        </Form.Item>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]} style={{ flex: 1 }}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="length_m" label="Длина на списание, м" rules={[{ required: true }]} style={{ flex: 1 }}>
            <InputNumber min={0.01} step={0.1} style={{ width: "100%" }} />
          </Form.Item>
        </Space>
        <Form.Item name="strip_width_mm" label="Ширина штрипса плёнки для окутки, мм">
          <InputNumber min={1} style={{ width: "100%" }} placeholder="не задана" />
        </Form.Item>
        <Form.Item name="area" label="Участок (пусто — общая для всех)">
          <Select allowClear options={areaOptions} placeholder="Общая для всех участков" />
        </Form.Item>
        <Form.Item
          name="default_material_sku_id"
          label="Закрепить плёнку"
          extra="При загрузке задания из файла текст цвета для этой детали не смотрится — подставляется эта позиция."
        >
          <Select
            allowClear
            showSearch
            loading={skusQuery.isLoading}
            options={skuOptions}
            placeholder="Не закреплено — подбор по тексту файла"
            optionFilterProp="label"
          />
        </Form.Item>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="min_stock_pieces" label="Мин. остаток, шт" style={{ flex: 1 }}>
            <InputNumber min={0} style={{ width: "100%" }} placeholder="не задан" />
          </Form.Item>
          <Form.Item name="min_batch_pieces" label="Мин. партия производства, шт" style={{ flex: 1 }}>
            <InputNumber min={1} style={{ width: "100%" }} placeholder="не задана" />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}
