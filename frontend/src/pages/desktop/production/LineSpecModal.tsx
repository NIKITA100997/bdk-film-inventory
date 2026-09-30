import { useEffect } from "react";
import { Form, InputNumber, Modal, Select, Typography, message } from "antd";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { updateTaskLineSpec, type ProductionTaskLine, type ProductionTaskLineSpecUpdate } from "../../../api/production";
import { listMaterialSkus } from "../../../api/dictionaries";
import { skuLabel } from "../../../api/units";

/** Правка размера/материала строки задания (пока размеры ещё тестируются):
 * ширина детали, длина, штрипс, номенклатура плёнки. */
export default function LineSpecModal({ taskId, line, onClose }: { taskId: number; line: ProductionTaskLine; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<ProductionTaskLineSpecUpdate>();
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  useEffect(() => {
    const current = skusQuery.data?.find(
      (s) => s.material.name === line.material && s.color.name === line.color && Math.abs(s.thickness.value_mm - (line.thickness ?? NaN)) < 0.001,
    );
    form.setFieldsValue({ width_mm: line.width_mm, length_m: line.length_m, strip_width_mm: line.strip_width_mm ?? undefined, sku_id: current?.id });
  }, [form, line, skusQuery.data]);
  const mutation = useMutation({
    mutationFn: (payload: ProductionTaskLineSpecUpdate) => updateTaskLineSpec(taskId, line.id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success("Строка задания обновлена");
      onClose();
    },
    onError: (e) =>
      message.error(isAxiosError(e) && typeof e.response?.data?.detail === "string" ? e.response.data.detail : "Не удалось изменить строку"),
  });
  return (
    <Modal
      open
      title={`Размер/материал строки — ${line.part_name ?? ""}`}
      onCancel={onClose}
      onOk={() => form.validateFields().then((v) => mutation.mutate(v))}
      confirmLoading={mutation.isPending}
      okText="Сохранить"
      cancelText="Отмена"
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Если по этой строке уже была резка, отчёт о выпуске или распределение по линии — изменить размер/материал не получится,
        об этом скажет ошибка при сохранении.
      </Typography.Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item name="sku_id" label="Материал (номенклатура)">
          <Select
            showSearch
            placeholder="Оставить как есть"
            allowClear
            optionFilterProp="label"
            options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
          />
        </Form.Item>
        <Form.Item name="width_mm" label="Ширина детали (заготовки), мм" rules={[{ required: true }]}>
          <InputNumber min={0.01} step={0.01} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
          <InputNumber min={0.01} step={0.001} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="strip_width_mm" label="Ширина плёнки на укутку (штрипс), мм" tooltip="Пусто — считается автоматически по названию детали">
          <InputNumber min={0.01} step={0.01} style={{ width: "100%" }} placeholder="авто" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
