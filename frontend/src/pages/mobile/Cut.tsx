import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Typography, Descriptions, Alert, message } from "antd";
import { useMutation } from "@tanstack/react-query";
import { getUnit, cutUnit, type MaterialUnit } from "../../api/units";

export default function Cut() {
  const [unit, setUnit] = useState<MaterialUnit | null>(null);
  const [result, setResult] = useState<MaterialUnit | null>(null);
  const [scanForm] = Form.useForm<{ id: number }>();
  const [cutForm] = Form.useForm<{ cut_length_m: number; remainder_location?: string }>();

  const scanMutation = useMutation({
    mutationFn: (id: number) => getUnit(id),
    onSuccess: (u) => {
      setUnit(u);
      setResult(null);
    },
    onError: () => message.error("Единица не найдена"),
  });

  const cutMutation = useMutation({
    mutationFn: (values: { cut_length_m: number; remainder_location?: string }) => cutUnit(unit!.id, values),
    onSuccess: (u) => {
      setResult(u);
      setUnit(null);
      scanForm.resetFields();
      cutForm.resetFields();
      message.success("Раскрой выполнен, кусок списан на производство");
    },
    onError: () => message.error("Не удалось выполнить раскрой — проверьте длину и статус единицы"),
  });

  return (
    <Card>
      <Typography.Title level={4}>Раскрой</Typography.Title>
      <Typography.Paragraph type="secondary">
        Только цельнолистовые двери: на складе (совмещённая резка) или на месте, на стеллаже Б.
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
            <Descriptions.Item label="Текущая длина">
              {unit.width_mm} мм × {unit.length_m} м
            </Descriptions.Item>
          </Descriptions>
          <Form form={cutForm} layout="vertical" onFinish={(v) => cutMutation.mutate(v)}>
            <Form.Item name="cut_length_m" label="Отрезать, м" rules={[{ required: true }]}>
              <InputNumber min={0.01} max={unit.length_m} step={0.01} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="remainder_location" label="Ячейка для остатка на стеллаже Б (опционально)">
              <Input placeholder="Б-1-02" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={cutMutation.isPending}>
              Списать без бирки
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
          message={
            result.length_m > 0
              ? `Останется ${result.length_m} м — тот же ID №${result.id}`
              : `Единица №${result.id} полностью использована и списана`
          }
        />
      )}
    </Card>
  );
}
