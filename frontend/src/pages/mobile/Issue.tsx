import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Select, Typography, Alert, message } from "antd";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { issueUnit, type IssueRequest, type IssueResult } from "../../api/units";

const areaOptions = [
  { value: "okutka_tsargovykh", label: "Окутка царговых" },
  { value: "shchitovye_dveri", label: "Щитовые двери" },
  { value: "tselnolistovye_dveri", label: "Цельнолистовые двери" },
];

export default function Issue() {
  const navigate = useNavigate();
  const [result, setResult] = useState<IssueResult | null>(null);
  const [form] = Form.useForm<IssueRequest>();

  const mutation = useMutation({
    mutationFn: issueUnit,
    onSuccess: (res) => {
      setResult(res);
      if (res.outcome === "issued") message.success(`Выдана единица № ${res.unit!.id}`);
    },
    onError: () => message.error("Не удалось оформить выдачу"),
  });

  return (
    <Card>
      <Typography.Title level={4}>Выдача участку</Typography.Title>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          setResult(null);
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

      {result?.outcome === "not_found" && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message="Точного совпадения по ширине нет"
          description="Подходящего штрипса или донора на хранении не найдено. Режьте новый рулон."
        />
      )}

      {result?.outcome === "donor_suggested" && result.donor && (
        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          message={`Есть штрипс №${result.donor.unit_id}, ширина ${result.donor.width_mm} мм, класс ${result.donor.width_class} (используется редко)`}
          description={`Рекомендуем отрезать ${result.donor.recommended_cut_mm} мм, отход ${result.donor.waste_mm} мм. Оператор режет вручную через «Разделить рулон» и затем повторяет выдачу на полученный кусок.`}
          action={
            <Button size="small" type="primary" onClick={() => navigate("/m/split")}>
              Разделить рулон
            </Button>
          }
        />
      )}

      {result?.outcome === "issued" && result.unit && (
        <Alert
          style={{ marginTop: 16 }}
          type="success"
          showIcon
          message={`Выдано: № ${result.unit.id} — ${result.unit.width_mm} мм × ${result.unit.length_m} м`}
        />
      )}
    </Card>
  );
}
