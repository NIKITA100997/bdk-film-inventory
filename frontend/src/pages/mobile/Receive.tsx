import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Typography, List, Row, Col, Statistic, message } from "antd";
import { useMutation } from "@tanstack/react-query";
import { receiveUnits, placeUnit, printLabel, skuLabel, type MaterialUnit, type ReceiveRequest } from "../../api/units";
import { suggestLocation } from "../../api/storage";
import DictAutoComplete from "../../components/DictAutoComplete";

type LineValues = Omit<ReceiveRequest, "upd_number" | "pallet_number" | "location_code">;

async function addLineAndPlace(upd_number: string, pallet_number: string, values: LineValues): Promise<MaterialUnit[]> {
  const created = await receiveUnits({ ...values, upd_number, pallet_number });
  const placed: MaterialUnit[] = [];
  for (const unit of created) {
    const suggestion = await suggestLocation({ material_sku_id: unit.material_sku.id, width_mm: unit.width_mm, parent_id: null });
    placed.push(suggestion ? await placeUnit(unit.id, suggestion) : unit);
  }
  return placed;
}

export default function Receive() {
  const [sessionStarted, setSessionStarted] = useState(false);
  const [upd, setUpd] = useState("");
  const [pallet, setPallet] = useState("");
  const [sessionUnits, setSessionUnits] = useState<MaterialUnit[]>([]);
  const [finished, setFinished] = useState(false);
  const [headerForm] = Form.useForm<{ upd_number: string; pallet_number: string }>();
  const [lineForm] = Form.useForm<LineValues>();

  const addLineMutation = useMutation({
    mutationFn: (values: LineValues) => addLineAndPlace(upd, pallet, values),
    onSuccess: (units) => {
      setSessionUnits((s) => [...s, ...units]);
      const unplaced = units.filter((u) => !u.location_code).length;
      message.success(
        unplaced
          ? `Добавлено ${units.length}, без места автоматически: ${unplaced} — разместите вручную позже`
          : `Добавлено и размещено: ${units.length}`,
      );
      // Материал/цвет/толщина/производитель остаются для следующего рулона
      // того же цвета (2.3 раздел бэклога доработок) — сбрасываем только
      // ширину/длину/количество.
      lineForm.setFieldsValue({ width_mm: undefined, length_m: undefined, quantity: 1 });
    },
    onError: () => message.error("Не удалось добавить рулон(ы) — проверьте данные"),
  });

  const startSession = (v: { upd_number: string; pallet_number: string }) => {
    setUpd(v.upd_number);
    setPallet(v.pallet_number);
    setSessionStarted(true);
  };

  const newSession = () => {
    setSessionStarted(false);
    setSessionUnits([]);
    setFinished(false);
    headerForm.resetFields();
    lineForm.resetFields();
  };

  const positionsCount = new Set(sessionUnits.map((u) => u.material_sku.id)).size;
  const unplacedCount = sessionUnits.filter((u) => !u.location_code).length;

  return (
    <Card>
      <Typography.Title level={4}>Приёмка партии</Typography.Title>

      {!sessionStarted && (
        <Form form={headerForm} layout="vertical" onFinish={startSession}>
          <Form.Item name="upd_number" label="Номер УПД" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="pallet_number" label="Номер паллеты" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            Начать приёмку
          </Button>
        </Form>
      )}

      {sessionStarted && !finished && (
        <>
          <Typography.Paragraph type="secondary">
            УПД {upd}, паллета {pallet}. Заполните рулон и нажмите «Добавить и дальше» — ячейка подбирается
            автоматически, материал/цвет/толщина/производитель остаются для следующей строки.
          </Typography.Paragraph>

          <Form form={lineForm} layout="vertical" onFinish={(v) => addLineMutation.mutate(v)} initialValues={{ quantity: 1 }}>
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
              <InputNumber min={1} style={{ width: "100%" }} autoFocus />
            </Form.Item>
            <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
              <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="quantity" label="Количество одинаковых рулонов" rules={[{ required: true }]}>
              <InputNumber min={1} max={200} style={{ width: "100%" }} />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={addLineMutation.isPending}>
              Добавить и дальше
            </Button>
          </Form>

          {sessionUnits.length > 0 && (
            <>
              <Typography.Title level={5} style={{ marginTop: 24 }}>
                В этой приёмке: {sessionUnits.length}
              </Typography.Title>
              <List
                size="small"
                bordered
                dataSource={sessionUnits}
                renderItem={(u) => (
                  <List.Item>
                    № {u.id} — {skuLabel(u.material_sku)}, {u.width_mm}×{u.length_m} — {u.location_code ?? "без места"}
                  </List.Item>
                )}
              />
              <Button block style={{ marginTop: 16 }} onClick={() => setFinished(true)}>
                Завершить приёмку
              </Button>
            </>
          )}
        </>
      )}

      {finished && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Statistic title="Рулонов принято" value={sessionUnits.length} />
            </Col>
            <Col span={8}>
              <Statistic title="Позиций материала" value={positionsCount} />
            </Col>
            <Col span={8}>
              <Statistic title="Без места" value={unplacedCount} valueStyle={unplacedCount ? { color: "#C97A2B" } : undefined} />
            </Col>
          </Row>
          <Button type="primary" block onClick={() => sessionUnits.forEach((u) => printLabel(u.id))}>
            Печать всех этикеток
          </Button>
          <Button block style={{ marginTop: 8 }} onClick={newSession}>
            Новая приёмка
          </Button>
        </>
      )}
    </Card>
  );
}
