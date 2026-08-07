import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Typography, List, message } from "antd";
import { useMutation } from "@tanstack/react-query";
import { receiveUnits, printLabel, type MaterialUnit, type ReceiveRequest } from "../../api/units";
import DictAutoComplete from "../../components/DictAutoComplete";

export default function Receive() {
  const [created, setCreated] = useState<MaterialUnit[]>([]);
  const [form] = Form.useForm<ReceiveRequest>();

  const mutation = useMutation({
    mutationFn: receiveUnits,
    onSuccess: (units) => {
      setCreated(units);
      message.success(`Создано единиц: ${units.length}`);
      form.resetFields();
    },
    onError: () => message.error("Не удалось оформить приёмку"),
  });

  return (
    <Card>
      <Typography.Title level={4}>Приёмка</Typography.Title>
      <Form form={form} layout="vertical" onFinish={(values) => mutation.mutate(values)}>
        <Form.Item name="upd_number" label="Номер УПД" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="pallet_number" label="Номер паллеты" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
          <DictAutoComplete kind="materials" />
        </Form.Item>
        <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
          <DictAutoComplete kind="colors" />
        </Form.Item>
        <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
          <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
          <DictAutoComplete kind="manufacturers" />
        </Form.Item>
        <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
          <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="quantity" label="Количество рулонов" rules={[{ required: true }]} initialValue={1}>
          <InputNumber min={1} max={200} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="location_code" label="Ячейка размещения (опционально)">
          <Input placeholder="Р-3-07" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Оформить приёмку
        </Button>
      </Form>

      {created.length > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              Созданные единицы
            </Typography.Title>
            <Button type="primary" onClick={() => created.forEach((u) => printLabel(u.id))}>
              Печать всех этикеток
            </Button>
          </div>
          <List
            bordered
            style={{ marginTop: 12 }}
            dataSource={created}
            renderItem={(unit) => (
              <List.Item
                actions={[
                  <Button key="print" type="primary" onClick={() => printLabel(unit.id)}>
                    Печать этикетки
                  </Button>,
                ]}
              >
                № {unit.id} — {unit.width_mm} мм × {unit.length_m} м
              </List.Item>
            )}
          />
        </>
      )}
    </Card>
  );
}
