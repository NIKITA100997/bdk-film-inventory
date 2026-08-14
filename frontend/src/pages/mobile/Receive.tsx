import { useState } from "react";
import { Alert, Button, Card, Form, Input, InputNumber, Select, Typography, List, Row, Col, Statistic, message } from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { receiveAndAutoPlace, printLabelsBatch, skuLabel, type MaterialUnit, type ReceiveRequest } from "../../api/units";
import { listWarehouses } from "../../api/storage";
import { listPurchaseRequests, fulfillPurchaseRequest } from "../../api/purchasing";
import DictAutoComplete from "../../components/DictAutoComplete";
import { useDraftForm } from "../../hooks/useDraftForm";

type LineValues = Omit<ReceiveRequest, "upd_number" | "pallet_number" | "location_code">;
type HeaderValues = { upd_number: string; pallet_number: string; warehouse_id?: number; purchase_request_id?: number };

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
  const [lastAdded, setLastAdded] = useState<MaterialUnit[] | null>(null);
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

  // Открытые заявки на закупку (раздел про ускорение приёмки) — необязательная
  // привязка: если эта поставка закрывает конкретную заявку, выбрать её здесь,
  // а не сопоставлять вручную потом на "Закупках".
  const openRequestsQuery = useQuery({ queryKey: ["purchase-requests", "open"], queryFn: () => listPurchaseRequests("open") });
  const fulfillMutation = useMutation({
    mutationFn: ({ id, updNumber }: { id: number; updNumber: string }) => fulfillPurchaseRequest(id, updNumber),
    onSuccess: () => message.success("Заявка на закупку привязана и закрыта"),
    onError: () => message.warning("Приёмка продолжится, но заявка не привязалась — привяжите вручную на «Закупках»"),
  });

  const addLineMutation = useMutation({
    mutationFn: (values: LineValues) =>
      receiveAndAutoPlace({ ...values, upd_number: upd, pallet_number: pallet }, warehouseId),
    onSuccess: (units) => {
      setSessionUnits((s) => [...s, ...units]);
      setLastAdded(units);
      // Сохраняем все параметры рулона (ширину/длину/материал/цвет) для быстрой
      // повторной приёмки одинаковых рулонов с той же паллеты.
      lineForm.setFieldsValue({ quantity: 1 });
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
    if (v.purchase_request_id) {
      fulfillMutation.mutate({ id: v.purchase_request_id, updNumber: v.upd_number });
    }
  };

  const newSession = () => {
    setSessionStarted(false);
    setSessionUnits([]);
    setLastAdded(null);
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
          {(openRequestsQuery.data ?? []).length > 0 && (
            <Form.Item name="purchase_request_id" label="Открытая заявка на закупку (опционально)">
              <Select
                size="large"
                allowClear
                showSearch
                placeholder="Эта поставка закрывает заявку…"
                optionFilterProp="label"
                options={(openRequestsQuery.data ?? []).map((r) => ({
                  value: r.id,
                  label: `${r.material}, ${r.color}, ${r.thickness} мм — ${r.requested_area_m2} м²`,
                }))}
              />
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
            <Row gutter={8} style={{ marginBottom: 16 }}>
              {[1, 5, 9, 10].map((num) => (
                <Col key={num} span={6}>
                  <Button block size="large" onClick={() => lineForm.setFieldValue("quantity", num)}>
                    {num} шт
                  </Button>
                </Col>
              ))}
            </Row>
            <Button size="large" type="primary" htmlType="submit" block loading={addLineMutation.isPending}>
              Добавить и дальше
            </Button>
          </Form>

          {lastAdded && (
            <Alert
              style={{ marginTop: 16 }}
              showIcon
              type={lastAdded.every((u) => u.location_code) ? "success" : "warning"}
              message={
                lastAdded.every((u) => u.location_code)
                  ? lastAdded.length === 1
                    ? `№${lastAdded[0].id} → ячейка ${lastAdded[0].location_code}`
                    : `${lastAdded.length} рулонов размещено: ${lastAdded.map((u) => u.location_code).join(", ")}`
                  : `Без места автоматически: ${lastAdded.filter((u) => !u.location_code).length} из ${lastAdded.length} — разместите вручную через карточку единицы после завершения приёмки`
              }
            />
          )}

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
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={12} sm={8}>
              <Statistic title="Рулонов принято" value={sessionUnits.length} />
            </Col>
            <Col xs={12} sm={8}>
              <Statistic title="Позиций материала" value={positionsCount} />
            </Col>
            <Col xs={24} sm={8}>
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
