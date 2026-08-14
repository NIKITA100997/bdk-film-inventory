import { useState } from "react";
import { Card, Tag, Button, Modal, Form, InputNumber, Input, Space, Typography, Empty, Tabs, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import {
  listPurchaseRequests,
  createPurchaseRequest,
  updatePurchaseRequest,
  closePurchaseRequest,
  type PurchaseRequest,
  type PurchaseRequestCreate,
  type PurchaseRequestUpdate,
} from "../../api/purchasing";
import { getSupplierStats, type SupplierStats } from "../../api/suppliers";
import DictAutoComplete from "../../components/DictAutoComplete";

export default function Purchasing() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<Partial<PurchaseRequestCreate> | null>(null);
  const [editingRequest, setEditingRequest] = useState<PurchaseRequest | null>(null);
  const [form] = Form.useForm<PurchaseRequestCreate>();
  const [editForm] = Form.useForm<PurchaseRequestUpdate>();

  const requestsQuery = useQuery({ queryKey: ["purchase-requests"], queryFn: () => listPurchaseRequests() });
  const supplierStatsQuery = useQuery({ queryKey: ["supplier-stats"], queryFn: getSupplierStats });

  const createMutation = useMutation({
    mutationFn: createPurchaseRequest,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      setCreateOpen(false);
      form.resetFields();
      message.success("Заявка создана");
    },
    onError: () => message.error("Не удалось создать заявку"),
  });

  const closeMutation = useMutation({
    mutationFn: (id: number) => closePurchaseRequest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-stats"] });
      message.success("Заявка закрыта");
    },
    onError: () => message.error("Не удалось закрыть заявку"),
  });

  // История цен и сроков поставщика (раздел про расширение функционала) —
  // цена/поставщик часто согласовываются позже создания заявки, не сразу.
  const updateMutation = useMutation({
    mutationFn: (payload: PurchaseRequestUpdate) => updatePurchaseRequest(editingRequest!.id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-stats"] });
      setEditingRequest(null);
      message.success("Заявка обновлена");
    },
    onError: () => message.error("Не удалось обновить заявку"),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Tabs
        items={[
          {
            key: "requests",
            label: "Заявки поставщику",
            children: (
              <Card
                extra={
                  <Button
                    type="primary"
                    onClick={() => {
                      setPrefill(null);
                      setCreateOpen(true);
                    }}
                  >
                    Новая заявка
                  </Button>
                }
              >
                <ResponsiveTable<PurchaseRequest>
                  rowKey="id"
                  loading={requestsQuery.isLoading}
                  dataSource={requestsQuery.data ?? []}
                  pagination={{ pageSize: 20 }}
                  scroll={{ x: "max-content" }}
                  columns={[
                    { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
                    { title: "Запрошено, м²", dataIndex: "requested_area_m2" },
                    { title: "Остаток на складе, м²", dataIndex: "current_stock_m2" },
                    { title: "Поставщик", dataIndex: "supplier", render: (v: string | null) => v ?? "—" },
                    {
                      title: "Цена, ₽/м²",
                      dataIndex: "price_per_m2",
                      render: (v: number | null) => v ?? "—",
                    },
                    { title: "Комментарий", dataIndex: "note", render: (v: string | null) => v ?? "—" },
                    {
                      title: "Происхождение",
                      dataIndex: "origin",
                      render: (v: string) =>
                        v === "shop_floor" ? <Tag color="blue">С цеха</Tag> : <Tag>Плановая</Tag>,
                    },
                    {
                      title: "Статус",
                      dataIndex: "status",
                      render: (v: string, r) => (
                        <Space direction="vertical" size={0}>
                          {v === "open" ? <Tag color="orange">Открыта</Tag> : <Tag color="green">Закрыта</Tag>}
                          {r.linked_upd_number && (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              УПД {r.linked_upd_number}
                            </Typography.Text>
                          )}
                        </Space>
                      ),
                    },
                    {
                      title: "Создана",
                      dataIndex: "created_at",
                      render: (v: string) => new Date(v).toLocaleDateString("ru-RU"),
                    },
                    {
                      title: "",
                      render: (_, r) => (
                        <Space>
                          <Button
                            size="small"
                            onClick={() => {
                              setEditingRequest(r);
                              editForm.setFieldsValue({ supplier: r.supplier ?? undefined, price_per_m2: r.price_per_m2 ?? undefined });
                            }}
                          >
                            Поставщик/цена
                          </Button>
                          {r.status === "open" && (
                            <Button size="small" loading={closeMutation.isPending} onClick={() => closeMutation.mutate(r.id)}>
                              Закрыть вручную
                            </Button>
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: "suppliers",
            label: "Поставщики",
            children: (
              <Card>
                <Typography.Paragraph type="secondary">
                  Средняя цена и срок поставки (закрытие минус создание заявки) — только по закрытым заявкам с
                  указанным поставщиком.
                </Typography.Paragraph>
                {(supplierStatsQuery.data ?? []).length === 0 ? (
                  <Empty description="Пока нет закрытых заявок с поставщиком" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  <ResponsiveTable<SupplierStats>
                    rowKey="supplier_id"
                    loading={supplierStatsQuery.isLoading}
                    dataSource={supplierStatsQuery.data ?? []}
                    pagination={false}
                    scroll={{ x: "max-content" }}
                    columns={[
                      { title: "Поставщик", dataIndex: "supplier_name" },
                      { title: "Закрыто заявок", dataIndex: "closed_requests", sorter: (a, b) => a.closed_requests - b.closed_requests },
                      {
                        title: "Средняя цена, ₽/м²",
                        dataIndex: "avg_price_per_m2",
                        render: (v: number | null) => v ?? "—",
                        sorter: (a, b) => (a.avg_price_per_m2 ?? 0) - (b.avg_price_per_m2 ?? 0),
                      },
                      {
                        title: "Средний срок, дней",
                        dataIndex: "avg_lead_time_days",
                        render: (v: number | null) => v ?? "—",
                        sorter: (a, b) => (a.avg_lead_time_days ?? 0) - (b.avg_lead_time_days ?? 0),
                      },
                      {
                        title: "Последняя заявка",
                        dataIndex: "last_request_at",
                        render: (v: string) => new Date(v).toLocaleDateString("ru-RU"),
                      },
                    ]}
                  />
                )}
              </Card>
            ),
          },
        ]}
      />

      <Modal
        title="Новая заявка поставщику"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={form}
          initialValues={prefill ?? undefined}
          onFinish={(v) => createMutation.mutate(v)}
        >
          <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
            <DictAutoComplete kind="materials" />
          </Form.Item>
          <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
            <DictAutoComplete kind="colors" />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="requested_area_m2" label="Запросить, м²" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="supplier" label="Поставщик (опционально)">
            <DictAutoComplete kind="suppliers" />
          </Form.Item>
          <Form.Item name="price_per_m2" label="Цена, ₽/м² (опционально)">
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="note" label="Комментарий (номер заказа поставщику и т.п.)">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать заявку
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Поставщик и цена — заявка №${editingRequest?.id ?? ""}`}
        open={!!editingRequest}
        onCancel={() => setEditingRequest(null)}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical" form={editForm} onFinish={(v) => updateMutation.mutate(v)}>
          <Form.Item name="supplier" label="Поставщик">
            <DictAutoComplete kind="suppliers" />
          </Form.Item>
          <Form.Item name="price_per_m2" label="Цена, ₽/м²">
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={updateMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
