import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Typography, Descriptions, Alert, message } from "antd";
import { useMutation } from "@tanstack/react-query";
import { getUnit, splitUnit, printLabel, skuLabel, type MaterialUnit, type SplitResponse } from "../../api/units";

export default function Split() {
  const [unit, setUnit] = useState<MaterialUnit | null>(null);
  const [result, setResult] = useState<SplitResponse | null>(null);
  const [scanForm] = Form.useForm<{ id: number }>();
  const [splitForm] = Form.useForm<{ separate_width_mm: number; new_unit_location?: string }>();

  const scanMutation = useMutation({
    mutationFn: (id: number) => getUnit(id),
    onSuccess: (u) => {
      setUnit(u);
      setResult(null);
    },
    onError: () => message.error("Единица не найдена"),
  });

  const splitMutation = useMutation({
    mutationFn: (values: { separate_width_mm: number; new_unit_location?: string }) =>
      splitUnit(unit!.id, values),
    onSuccess: (res) => {
      setResult(res);
      setUnit(null);
      scanForm.resetFields();
      splitForm.resetFields();
      message.success("Рулон разделён");
    },
    onError: () => message.error("Не удалось разделить — проверьте ширину и статус единицы"),
  });

  return (
    <Card>
      <Typography.Title level={4}>Разделить рулон</Typography.Title>

      {!unit && (
        <Form form={scanForm} layout="inline" onFinish={(v) => scanMutation.mutate(v.id)}>
          <Form.Item name="id" label="ID единицы" rules={[{ required: true }]}>
            <InputNumber autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={scanMutation.isPending}>
            Найти
          </Button>
        </Form>
      )}

      {unit && (
        <>
          <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label="ID">№ {unit.id}</Descriptions.Item>
            <Descriptions.Item label="Материал">{skuLabel(unit.material_sku)}</Descriptions.Item>
            <Descriptions.Item label="Текущая ширина/длина">
              {unit.width_mm} мм × {unit.length_m} м
            </Descriptions.Item>
          </Descriptions>
          <Form
            form={splitForm}
            layout="vertical"
            onFinish={(v) => splitMutation.mutate(v)}
          >
            <Form.Item
              name="separate_width_mm"
              label="Ширина отделяемой части, мм"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} max={unit.width_mm - 1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="new_unit_location" label="Ячейка для отделяемой части (опционально)">
              <Input placeholder="Ш-2-04-06" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={splitMutation.isPending}>
              Разделить
            </Button>
            <Button block style={{ marginTop: 8 }} onClick={() => setUnit(null)}>
              Отмена
            </Button>
          </Form>
        </>
      )}

      {result && (
        <>
          <Alert
            type="success"
            showIcon
            message={`Останется: ${result.parent.width_mm} мм, тот же ID №${result.parent.id} — бирка не меняется`}
            style={{ marginBottom: 12 }}
          />
          {result.new_unit && (
            <Alert
              type="info"
              showIcon
              message={`Новый штрипс №${result.new_unit.id}: ${result.new_unit.width_mm} мм, ${result.new_unit.length_m} м`}
              action={
                <Button size="small" type="primary" onClick={() => printLabel(result.new_unit!.id)}>
                  Печать бирки
                </Button>
              }
            />
          )}
        </>
      )}
    </Card>
  );
}
