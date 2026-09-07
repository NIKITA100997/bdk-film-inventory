import { useState } from "react";
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, List, Row, Col, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate } from "react-router-dom";
import Statistic from "../../components/Statistic";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  receiveAndAutoPlace,
  printLabelsBatch,
  skuLabel,
  listReceipts,
  type MaterialUnit,
  type ReceiveRequest,
  type ReceiptSession,
} from "../../api/units";
import { listWarehouses } from "../../api/storage";
import { listPurchaseRequests, fulfillPurchaseRequest } from "../../api/purchasing";
import DictAutoComplete from "../../components/DictAutoComplete";
import ExistingSkuPicker from "../../components/ExistingSkuPicker";
import OccurredAtField from "../../components/OccurredAtField";
import { toOccurredAtIso } from "../../utils/occurredAt";
import { useDraftForm } from "../../hooks/useDraftForm";

type LineValues = Omit<ReceiveRequest, "upd_number" | "pallet_number" | "location_code" | "occurred_at" | "thickness"> & {
  thickness: string;
};
type HeaderValues = {
  upd_number: string;
  pallet_number: string;
  warehouse_id?: number;
  purchase_request_id?: number;
  occurred_at?: Dayjs | null;
};

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
  const [occurredAt, setOccurredAt] = useState<Dayjs | null>(null);
  // Раздел про историю приёмок (проверка правильности внесения) —
  // доступна всегда, независимо от того, идёт ли сейчас сессия приёмки.
  const [historyOpen, setHistoryOpen] = useState(false);
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
  // а не сопоставлять вручную потом на "Закупках". Список заявок читает и
  // склад (units.receive) — этот экран и так требует units.receive, значит
  // право уже есть у всех, кто сюда попал (backend/api/purchasing.py).
  const openRequestsQuery = useQuery({ queryKey: ["purchase-requests", "open"], queryFn: () => listPurchaseRequests("open") });
  const fulfillMutation = useMutation({
    mutationFn: ({ id, updNumber }: { id: number; updNumber: string }) => fulfillPurchaseRequest(id, updNumber),
    onSuccess: () => message.success("Заявка на закупку привязана и закрыта"),
    onError: () => message.warning("Приёмка продолжится, но заявка не привязалась — привяжите вручную на «Закупках»"),
  });

  const addLineMutation = useMutation({
    mutationFn: (values: LineValues) =>
      receiveAndAutoPlace(
        {
          ...values,
          thickness: Number(values.thickness),
          upd_number: upd,
          pallet_number: pallet,
          occurred_at: toOccurredAtIso(occurredAt),
        },
        warehouseId,
      ),
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
    setOccurredAt(v.occurred_at ?? null);
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
    setOccurredAt(null);
    headerForm.resetFields();
    lineForm.resetFields();
  };

  const positionsCount = new Set(sessionUnits.map((u) => u.material_sku.id)).size;
  const unplacedCount = sessionUnits.filter((u) => !u.location_code).length;

  return (
    <Card>
      <Space align="center" style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Приёмка партии
        </Typography.Title>
        <Button size="small" onClick={() => setHistoryOpen(true)}>
          📜 История приёмок
        </Button>
      </Space>
      <ReceiptsHistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} />

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
          <OccurredAtField label="Дата приёмки всей партии (необязательно — по умолчанию сейчас)" />
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
            <Form.Item style={{ marginBottom: 16 }}>
              <ExistingSkuPicker
                onSelect={(sku) =>
                  lineForm.setFieldsValue({
                    material: sku.material.name,
                    color: sku.color.name,
                    thickness: String(sku.thickness.value_mm),
                    manufacturer: sku.manufacturer.name,
                  })
                }
              />
            </Form.Item>
            <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
              <DictAutoComplete kind="materials" />
            </Form.Item>
            <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
              <DictAutoComplete kind="colors" />
            </Form.Item>
            <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
              <DictAutoComplete kind="thicknesses" />
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

/** История приёмок (раздел про проверку правильности внесения) — одна
 * запись = одна сессия "Приёмка партии" (УПД+паллета), поэтому доступна
 * всегда, не только пока сессия идёт. Ширина/длина/ячейка в детальном
 * списке — то, что реально ввели при приёмке (снимок события "Приход" на
 * бэкенде), не текущее состояние рулона — если его успели порезать,
 * current_status/current_width_mm покажут это отдельно, не подменяя
 * исходную запись. */
function ReceiptsHistoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<ReceiptSession | null>(null);
  const receiptsQuery = useQuery({
    queryKey: ["receipts", search],
    queryFn: () => listReceipts({ search: search.trim() || undefined, limit: 50 }),
    enabled: open,
  });

  return (
    <>
      <Modal title="История приёмок" open={open} onCancel={onClose} footer={null} width={820} destroyOnHidden>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          Одна строка — одна приёмка (УПД + паллета). Кликните строку, чтобы свериться, что было реально введено.
        </Typography.Paragraph>
        <Input.Search
          placeholder="Поиск по номеру УПД или паллеты…"
          allowClear
          style={{ marginBottom: 12 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Table<ReceiptSession>
          size="small"
          tableLayout="fixed"
          rowKey={(s) => `${s.upd_number}-${s.pallet_number}`}
          loading={receiptsQuery.isLoading}
          dataSource={receiptsQuery.data ?? []}
          pagination={{ pageSize: 15 }}
          scroll={{ x: 700 }}
          locale={{ emptyText: search ? "Ничего не найдено" : "Приёмок за последние 90 дней нет" }}
          onRow={(s) => ({ onClick: () => setDetail(s), style: { cursor: "pointer" } })}
          columns={[
            { title: "Дата", width: 130, render: (_, s) => dayjs(s.received_at).format("DD.MM.YYYY HH:mm") },
            { title: "УПД", dataIndex: "upd_number", width: 120, ellipsis: true },
            { title: "Паллета", dataIndex: "pallet_number", width: 110, ellipsis: true },
            { title: "Кто принял", dataIndex: "received_by", width: 130, ellipsis: true },
            { title: "Склад", width: 110, ellipsis: true, render: (_, s) => s.warehouse_name ?? "—" },
            { title: "Рулонов", dataIndex: "unit_count", width: 80 },
            { title: "Всего, м²", width: 90, render: (_, s) => s.total_area_m2.toFixed(1) },
          ]}
        />
      </Modal>

      <Modal
        title={detail ? `Приёмка — УПД ${detail.upd_number}, паллета ${detail.pallet_number}` : ""}
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={null}
        width={760}
        destroyOnHidden
      >
        {detail && (
          <>
            <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
              Кликните строку, чтобы открыть карточку физической единицы.
            </Typography.Paragraph>
            <Table<(typeof detail.units)[number]>
              size="small"
              tableLayout="fixed"
              rowKey="unit_id"
              dataSource={detail.units}
              pagination={false}
              scroll={{ x: 660 }}
              onRow={(u) => ({
                onClick: () => navigate("/m/unit-card", { state: { unitId: u.unit_id } }),
                style: { cursor: "pointer" },
              })}
              columns={[
                { title: "№", dataIndex: "unit_id", width: 70 },
                {
                  title: "Материал",
                  render: (_, u) => `${u.material}, ${u.color}, ${u.thickness} мм, ${u.manufacturer}`,
                },
                { title: "Ширина, мм", dataIndex: "width_mm", width: 100 },
                { title: "Длина, м", dataIndex: "length_m", width: 90 },
                { title: "Ячейка при приёмке", width: 140, render: (_, u) => u.location_code ?? "—" },
                {
                  title: "Сейчас",
                  width: 190,
                  render: (_, u) => (
                    <Space size={4} wrap>
                      <Tag>{u.current_status.replace(/_/g, " ")}</Tag>
                      {u.current_width_mm !== u.width_mm && <Tag color="orange">уже {u.current_width_mm} мм — разрезан</Tag>}
                    </Space>
                  ),
                },
              ]}
            />
          </>
        )}
      </Modal>
    </>
  );
}
