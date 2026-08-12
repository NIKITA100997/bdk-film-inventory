import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Select, Typography, List, Row, Col, Statistic, message } from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { receiveAndAutoPlace, printLabelsBatch, skuLabel, type MaterialUnit, type ReceiveRequest } from "../../api/units";
import { listWarehouses } from "../../api/storage";
import DictAutoComplete from "../../components/DictAutoComplete";
import { useDraftForm } from "../../hooks/useDraftForm";

type LineValues = Omit<ReceiveRequest, "upd_number" | "pallet_number" | "location_code">;
type HeaderValues = { upd_number: string; pallet_number: string; warehouse_id?: number };

// Память на частый ввод: при повторной приёмке в тот же день паллеты часто
// идут подряд — предзаполняем последний номер, поле остаётся редактируемым.
// УПД не запоминаем — это номер конкретного документа поставщика,
// предзаполнение создало бы риск случайного дубля.
const LAST_PALLET_STORAGE_KEY = "bdk:lastPalletNumber";

export default function Receive() {
  const lastPalletNumber = localStorage.getItem(LAST_PALLET_STORAGE_KEY) ?? undefined;
  const [sessionStarted, setSessionStarted] = useState(false);
  const [upd, setUpd] = useState("");
  const [pallet, setPallet] = useState("");
  const [sessionUnits, setSessionUnits] = useState<MaterialUnit[]>([]);
  const [finished, setFinished] = useState(false);
  const [warehouseId, setWarehouseId] = useState<number | undefined>(undefined);
  const [headerForm] = Form.useForm<HeaderValues>();
  const [lineForm] = Form.useForm<LineValues>();
  const headerDraft = useDraftForm("draft:receive-header", headerForm);
  const lineDraft = useDraftForm("draft:receive-line", lineForm);

  // Выбор склада — только если складов больше одного (раздел про
  // мультисклад), иначе используется молча без лишнего поля в форме.
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });
  const activeWarehouses = (warehousesQuery.data ?? []).filter((w) => w.is_active);

  const addLineMutation = useMutation({
    mutationFn: (values: LineValues) =>
      receiveAndAutoPlace({ ...values, upd_number: upd, pallet_number: pallet }, warehouseId),
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
      lineDraft.clearDraft();
    },
    onError: () => message.error("Не удалось добавить рулон(ы) — проверьте данные"),
  });

  const startSession = (v: HeaderValues) => {
    setUpd(v.upd_number);
    setPallet(v.pallet_number);
    setWarehouseId(v.warehouse_id);
    setSessionStarted(true);
    localStorage.setItem(LAST_PALLET_STORAGE_KEY, v.pallet_number);
    headerDraft.clearDraft();
  };

  const newSession = () => {
    setSessionStarted(false);
    setSessionUnits([]);
    setFinished(false);
    setWarehouseId(undefined);
    headerForm.resetFields();
    lineForm.resetFields();
  };

  const positionsCount = new Set(sessionUnits.map((u) => u.material_sku.id)).size;
  const unplacedCount = sessionUnits.filter((u) => !u.location_code).length;

  return (
    <Card>
      <Typography.Title level={4}>Приёмка партии</Typography.Title>

      {!sessionStarted && (
        <Form
          form={headerForm}
          layout="vertical"
          onFinish={startSession}
          onValuesChange={headerDraft.handleValuesChange}
          initialValues={{ pallet_number: lastPalletNumber }}
        >
          <Form.Item name="upd_number" label="Номер УПД" rules={[{ required: true }]}>
            <Input size="large" />
          </Form.Item>
          <Form.Item name="pallet_number" label="Номер паллеты" rules={[{ required: true }]}>
            <Input size="large" />
          </Form.Item>
          {activeWarehouses.length > 1 && (
            <Form.Item name="warehouse_id" label="Склад" rules={[{ required: true }]}>
              <Select size="large" options={activeWarehouses.map((w) => ({ value: w.id, label: w.name }))} />
            </Form.Item>
          )}
          <Button size="large" type="primary" htmlType="submit" block>
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

          <Form
            form={lineForm}
            layout="vertical"
            onFinish={(v) => addLineMutation.mutate(v)}
            onValuesChange={lineDraft.handleValuesChange}
            initialValues={{ quantity: 1 }}
          >
            <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
              <DictAutoComplete kind="materials" />
            </Form.Item>
            <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
              <DictAutoComplete kind="colors" />
            </Form.Item>
            <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
              <InputNumber size="large" min={0} step={0.01} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
              <DictAutoComplete kind="manufacturers" />
            </Form.Item>
            <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
              <InputNumber size="large" min={1} style={{ width: "100%" }} autoFocus />
            </Form.Item>
            <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
              <InputNumber size="large" min={0.1} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="quantity" label="Количество одинаковых рулонов" rules={[{ required: true }]}>
              <InputNumber size="large" min={1} max={200} style={{ width: "100%" }} />
            </Form.Item>
            <Button size="large" type="primary" htmlType="submit" block loading={addLineMutation.isPending}>
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
          <Button type="primary" block onClick={() => printLabelsBatch(sessionUnits.map((u) => u.id))}>
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
