import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Select, Typography, Alert, message } from "antd";
import { isAxiosError } from "axios";
import { useMutation } from "@tanstack/react-query";
import { issueUnit, type IssueRequest, type MaterialUnit } from "../../api/units";

const areaOptions = [
  { value: "okutka_tsargovykh", label: "Окутка царговых" },
  { value: "shchitovye_dveri", label: "Щитовые двери" },
  { value: "tselnolistovye_dveri", label: "Цельнолистовые двери" },
];

export default function Issue() {
  const [issued, setIssued] = useState<MaterialUnit | null>(null);
  const [noMatch, setNoMatch] = useState(false);
  const [form] = Form.useForm<IssueRequest>();

  const mutation = useMutation({
    mutationFn: issueUnit,
    onSuccess: (unit) => {
      setIssued(unit);
      setNoMatch(false);
      message.success(`Выдана единица № ${unit.id}`);
    },
    onError: (e) => {
      if (isAxiosError(e) && e.response?.status === 404) {
        setNoMatch(true);
        setIssued(null);
      } else {
        message.error("Не удалось оформить выдачу");
      }
    },
  });

  return (
    <Card>
      <Typography.Title level={4}>Выдача участку</Typography.Title>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          setNoMatch(false);
          setIssued(null);
          mutation.mutate(values);
        }}
      >
        <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
          <Select options={areaOptions} />
        </Form.Item>
        <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
          <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="width_mm" label="Нужная ширина, мм" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="length_m" label="Нужная длина, м" rules={[{ required: true }]}>
          <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Найти и выдать
        </Button>
      </Form>

      {noMatch && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message="Точного совпадения по ширине нет"
          description="Подходящего штрипса на хранении не найдено. Отрежьте нужную ширину вручную через «Разделить рулон» от подходящего рулона/штрипса, либо режьте новый рулон."
        />
      )}

      {issued && (
        <Alert
          style={{ marginTop: 16 }}
          type="success"
          showIcon
          message={`Выдано: № ${issued.id} — ${issued.width_mm} мм × ${issued.length_m} м`}
        />
      )}
    </Card>
  );
}
