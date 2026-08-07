import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Typography, Descriptions, Alert, message } from "antd";
import { useMutation } from "@tanstack/react-query";
import { getUnit, placeUnit, skuLabel, type MaterialUnit } from "../../api/units";

export default function Place() {
  const [unit, setUnit] = useState<MaterialUnit | null>(null);
  const [result, setResult] = useState<MaterialUnit | null>(null);
  const [scanForm] = Form.useForm<{ id: number }>();
  const [placeForm] = Form.useForm<{ location_code: string }>();

  const scanMutation = useMutation({
    mutationFn: (id: number) => getUnit(id),
    onSuccess: (u) => {
      setUnit(u);
      setResult(null);
    },
    onError: () => message.error("Единица не найдена"),
  });

  const placeMutation = useMutation({
    mutationFn: (values: { location_code: string }) => placeUnit(unit!.id, values.location_code),
    onSuccess: (u) => {
      setResult(u);
      setUnit(null);
      scanForm.resetFields();
      placeForm.resetFields();
      message.success("Единица размещена");
    },
    onError: () => message.error("Не удалось разместить — проверьте статус единицы"),
  });

  return (
    <Card>
      <Typography.Title level={4}>Размещение в ячейку</Typography.Title>
      <Typography.Paragraph type="secondary">
        Для единиц, принятых без адреса, и для возвратов, которым нужна полка.
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
            <Descriptions.Item label="Материал">{skuLabel(unit.material_sku)}</Descriptions.Item>
            <Descriptions.Item label="Ширина×длина">
              {unit.width_mm} мм × {unit.length_m} м
            </Descriptions.Item>
            <Descriptions.Item label="Текущий адрес">{unit.location_code ?? "не размещена"}</Descriptions.Item>
          </Descriptions>
          <Form form={placeForm} layout="vertical" onFinish={(v) => placeMutation.mutate(v)}>
            <Form.Item name="location_code" label="Адрес ячейки" rules={[{ required: true }]}>
              <Input placeholder="Р-3-07 или Ш-2-04-06" autoFocus />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={placeMutation.isPending}>
              Разместить
            </Button>
            <Button block style={{ marginTop: 8 }} onClick={() => setUnit(null)}>
              Отмена
            </Button>
          </Form>
        </>
      )}

      {result && (
        <Alert type="success" showIcon message={`№ ${result.id} размещена в ${result.location_code}`} />
      )}
    </Card>
  );
}
