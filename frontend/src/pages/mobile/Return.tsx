import { useState } from "react";
import { Button, Card, Form, InputNumber, Typography, Descriptions, Alert, message } from "antd";
import { useMutation } from "@tanstack/react-query";
import { getUnit, returnUnit, type MaterialUnit } from "../../api/units";

export default function Return() {
  const [unit, setUnit] = useState<MaterialUnit | null>(null);
  const [result, setResult] = useState<MaterialUnit | null>(null);
  const [scanForm] = Form.useForm<{ id: number }>();
  const [returnForm] = Form.useForm<{ actual_length_m: number }>();

  const scanMutation = useMutation({
    mutationFn: (id: number) => getUnit(id),
    onSuccess: (u) => {
      setUnit(u);
      setResult(null);
    },
    onError: () => message.error("Единица не найдена"),
  });

  const returnMutation = useMutation({
    mutationFn: (values: { actual_length_m: number }) => returnUnit(unit!.id, values),
    onSuccess: (u) => {
      setResult(u);
      setUnit(null);
      scanForm.resetFields();
      returnForm.resetFields();
      message.success("Остаток возвращён на хранение");
    },
    onError: () => message.error("Не удалось оформить возврат — единица не выдана участку"),
  });

  return (
    <Card>
      <Typography.Title level={4}>Возврат</Typography.Title>
      <Typography.Paragraph type="secondary">
        Один и тот же экран для всех трёх участков — момент возврата решает регламент участка.
      </Typography.Paragraph>

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
            <Descriptions.Item label="Материал">
              {unit.material}, {unit.color}, {unit.thickness} мм
            </Descriptions.Item>
            <Descriptions.Item label="Числится за">{unit.area ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="Длина по учёту">{unit.length_m} м</Descriptions.Item>
          </Descriptions>
          <Form
            form={returnForm}
            layout="vertical"
            onFinish={(v) => returnMutation.mutate(v)}
            initialValues={{ actual_length_m: unit.length_m }}
          >
            <Form.Item name="actual_length_m" label="Фактическая текущая длина, м" rules={[{ required: true }]}>
              <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={returnMutation.isPending}>
              Вернуть на склад
            </Button>
            <Button block style={{ marginTop: 8 }} onClick={() => setUnit(null)}>
              Отмена
            </Button>
          </Form>
        </>
      )}

      {result && (
        <Alert
          type="success"
          showIcon
          message={`№ ${result.id} на хранении, длина ${result.length_m} м. Разместите в ячейку через «Размещение в ячейку», если требуется.`}
        />
      )}
    </Card>
  );
}
