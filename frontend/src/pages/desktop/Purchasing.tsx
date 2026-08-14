import { useState } from "react";
import { Card, Tag, Button, Modal, Form, InputNumber, Input, Space, Typography, Empty, Tabs, Checkbox, Collapse, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import {
  listPurchaseRequests,
  createPurchaseRequest,
  updatePurchaseRequest,
  closePurchaseRequest,
  deletePurchaseRequest,
  deleteSupplierOrder,
  listSupplierOrders,
  createSupplierOrder,
  getStockOverview,
  type PurchaseRequest,
  type PurchaseRequestCreate,
  type PurchaseRequestUpdate,
  type SupplierOrder,
  type StockOverviewLine,
} from "../../api/purchasing";
import { getSupplierStats, type SupplierStats } from "../../api/suppliers";
import DictAutoComplete from "../../components/DictAutoComplete";
import { useAuth } from "../../auth/AuthContext";

interface EditingPriceTarget {
  requestIds: number[];
  label: string;
  supplier?: string | null;
  price_per_m2?: number | null;
}

/** Экран снабженца (раздел про объединение заявок в заказ поставщику +
 * остатки с резервом) — четыре вкладки вместо прежних двух:
 * "Заявки поставщику" (как раньше, плюс чекбоксы и объединение в заказ),
 * "Заказы поставщикам" (новое — результат объединения), "Остатки и
 * резерв" (новое — проактивный заказ по остаткам, с учётом того, что уже
 * нужно текущим заданиям цеха) и "Поставщики" (как раньше). */
export default function Purchasing() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState("requests");
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<Partial<PurchaseRequestCreate> | null>(null);
  const [editingPrice, setEditingPrice] = useState<EditingPriceTarget | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [onlyUngrouped, setOnlyUngrouped] = useState(false);
  const [stockSupplierFilter, setStockSupplierFilter] = useState<string | null>(null);
  const [form] = Form.useForm<PurchaseRequestCreate>();
  const [editForm] = Form.useForm<PurchaseRequestUpdate>();
  const [orderForm] = Form.useForm<{ supplier: string; note?: string }>();

  const requestsQuery = useQuery({ queryKey: ["purchase-requests"], queryFn: () => listPurchaseRequests() });
  const supplierStatsQuery = useQuery({ queryKey: ["supplier-stats"], queryFn: getSupplierStats });
  const ordersQuery = useQuery({ queryKey: ["supplier-orders"], queryFn: listSupplierOrders });
  const stockOverviewQuery = useQuery({ queryKey: ["purchasing-stock-overview"], queryFn: getStockOverview, enabled: activeTab === "stock" });

  const createMutation = useMutation({
    mutationFn: createPurchaseRequest,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["purchasing-stock-overview"] });
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
      qc.invalidateQueries({ queryKey: ["supplier-orders"] });
      message.success("Заявка закрыта");
    },
    onError: () => message.error("Не удалось закрыть заявку"),
  });

  const deleteRequestMutation = useMutation({
    mutationFn: (id: number) => deletePurchaseRequest(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-orders"] });
      qc.invalidateQueries({ queryKey: ["purchasing-stock-overview"] });
      message.success(result.requested ? "Заявка на удаление отправлена администратору" : "Заявка удалена");
    },
    onError: () => message.error("Не удалось удалить"),
  });

  const deleteOrderMutation = useMutation({
    mutationFn: (id: number) => deleteSupplierOrder(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-orders"] });
      message.success(result.requested ? "Заявка на удаление отправлена администратору" : "Заказ удалён");
    },
    onError: () => message.error("Не удалось удалить"),
  });

  // История цен и сроков поставщика (раздел про расширение функционала) —
  // цена/поставщик часто согласовываются позже создания заявки, не сразу.
  // Один и тот же модал правит либо одну заявку (кнопка в "Заявках"), либо
  // сразу все заявки одной строки заказа (кнопка в "Заказах поставщикам").
  const updateMutation = useMutation({
    mutationFn: (payload: PurchaseRequestUpdate) =>
      Promise.all(editingPrice!.requestIds.map((id) => updatePurchaseRequest(id, payload))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-stats"] });
      qc.invalidateQueries({ queryKey: ["supplier-orders"] });
      setEditingPrice(null);
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить"),
  });

  const createOrderMutation = useMutation({
    mutationFn: createSupplierOrder,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-orders"] });
      qc.invalidateQueries({ queryKey: ["supplier-stats"] });
      setOrderModalOpen(false);
      orderForm.resetFields();
      setSelectedIds(new Set());
      message.success("Заказ создан");
    },
    onError: () => message.error("Не удалось создать заказ — часть заявок уже закрыта или в другом заказе"),
  });

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectableRows = (requestsQuery.data ?? []).filter((r) => r.status === "open" && r.order_id === null);
  const visibleRequests = onlyUngrouped
    ? (requestsQuery.data ?? []).filter((r) => r.order_id === null)
    : requestsQuery.data ?? [];
  const selectedRequests = selectableRows.filter((r) => selectedIds.has(r.id));
  const selectedLines = (() => {
    const byKey = new Map<string, { material: string; color: string; thickness: number; total: number }>();
    for (const r of selectedRequests) {
      const key = `${r.material}__${r.color}__${r.thickness}`;
      const existing = byKey.get(key);
      if (existing) existing.total += r.requested_area_m2;
      else byKey.set(key, { material: r.material, color: r.color, thickness: r.thickness, total: r.requested_area_m2 });
    }
    return Array.from(byKey.values());
  })();

  const openStockForSupplier = (supplierName: string) => {
    setStockSupplierFilter(supplierName);
    setActiveTab("stock");
  };

  const stockRows = (stockOverviewQuery.data ?? []).filter(
    (r) => !stockSupplierFilter || r.usual_supplier === stockSupplierFilter,
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
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
                <Space style={{ marginBottom: 12 }}>
                  <Button size="small" type={onlyUngrouped ? "default" : "primary"} ghost={onlyUngrouped} onClick={() => setOnlyUngrouped(false)}>
                    Все
                  </Button>
                  <Button size="small" type={onlyUngrouped ? "primary" : "default"} ghost={!onlyUngrouped} onClick={() => setOnlyUngrouped(true)}>
                    Не в заказе
                  </Button>
                </Space>
                <ResponsiveTable<PurchaseRequest>
                  tableKey="purchase-requests"
                  lockedColumns={["Материал"]}
                  defaultHiddenColumns={["Комментарий", "Цена, ₽/м²", "Создана"]}
                  rowKey="id"
                  loading={requestsQuery.isLoading}
                  dataSource={visibleRequests}
                  pagination={{ pageSize: 20 }}
                  scroll={{ x: "max-content" }}
                  columns={[
                    {
                      title: "",
                      render: (_, r) =>
                        r.status === "open" && r.order_id === null ? (
                          <Checkbox checked={selectedIds.has(r.id)} onChange={() => toggleSelect(r.id)} />
                        ) : null,
                    },
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
                      title: "Заказ",
                      dataIndex: "order_id",
                      render: (v: number | null) => (v ? <Tag color="purple">№{v}</Tag> : "—"),
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
                              setEditingPrice({
                                requestIds: [r.id],
                                label: `заявка №${r.id}`,
                                supplier: r.supplier,
                                price_per_m2: r.price_per_m2,
                              });
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
                          <Button size="small" danger loading={deleteRequestMutation.isPending} onClick={() => deleteRequestMutation.mutate(r.id)}>
                            {user?.is_superuser ? "Удалить" : "Запросить удаление"}
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />

                {selectedIds.size > 0 && (
                  <div
                    style={{
                      position: "sticky",
                      bottom: 0,
                      marginTop: 14,
                      background: "#1B1E2E",
                      color: "#F1EEE8",
                      borderRadius: 8,
                      padding: "12px 16px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>
                      <b>{selectedIds.size}</b> {selectedIds.size === 1 ? "заявка выбрана" : "заявки выбрано"} ·{" "}
                      {selectedLines.length} {selectedLines.length === 1 ? "позиция" : "позиций"}
                    </span>
                    <Space>
                      <Button ghost onClick={() => setSelectedIds(new Set())}>
                        Сбросить
                      </Button>
                      <Button type="primary" onClick={() => setOrderModalOpen(true)}>
                        Объединить в заказ поставщику →
                      </Button>
                    </Space>
                  </div>
                )}
              </Card>
            ),
          },
          {
            key: "orders",
            label: "Заказы поставщикам",
            children: (
              <Card>
                {(ordersQuery.data ?? []).length === 0 ? (
                  <Empty description="Заказов пока нет — объедините заявки на вкладке «Заявки поставщику»" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  <Collapse
                    items={(ordersQuery.data ?? []).map((order: SupplierOrder) => {
                      const totalArea = order.lines.reduce((sum, l) => sum + l.requested_area_m2, 0);
                      return {
                        key: order.id,
                        label: (
                          <Space wrap>
                            {order.is_open ? <Tag color="orange">Открыт</Tag> : <Tag color="green">Закрыт</Tag>}
                            <Typography.Text strong>{order.supplier}</Typography.Text>
                            <Typography.Text type="secondary">
                              {order.lines.length} {order.lines.length === 1 ? "позиция" : "позиций"} · {totalArea.toFixed(1)} м² ·{" "}
                              {new Date(order.created_at).toLocaleDateString("ru-RU")}
                            </Typography.Text>
                          </Space>
                        ),
                        children: (
                          <Space direction="vertical" size="small" style={{ width: "100%" }}>
                            {order.note && <Typography.Text type="secondary">{order.note}</Typography.Text>}
                            {order.lines.map((line, i) => (
                              <div
                                key={i}
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  padding: "8px 0",
                                  borderBottom: i < order.lines.length - 1 ? "1px dashed #E2DFD6" : "none",
                                  gap: 12,
                                }}
                              >
                                <div>
                                  <div>
                                    {line.material}, {line.color}, {line.thickness} мм
                                  </div>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    остаток на складе {line.current_stock_m2} м² · из {line.request_ids.length}{" "}
                                    {line.request_ids.length === 1 ? "заявки" : "заявок"}
                                  </Typography.Text>
                                </div>
                                <Space>
                                  <span>{line.requested_area_m2} м²</span>
                                  <Button
                                    size="small"
                                    onClick={() => {
                                      setEditingPrice({
                                        requestIds: line.request_ids,
                                        label: `${line.material}, ${line.color}, ${line.thickness} мм`,
                                        supplier: order.supplier,
                                        price_per_m2: null,
                                      });
                                      editForm.setFieldsValue({ supplier: order.supplier, price_per_m2: undefined });
                                    }}
                                  >
                                    Изменить цену
                                  </Button>
                                </Space>
                              </div>
                            ))}
                            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                              <Button
                                size="small"
                                danger
                                loading={deleteOrderMutation.isPending}
                                onClick={() => deleteOrderMutation.mutate(order.id)}
                              >
                                {user?.is_superuser ? "Удалить заказ" : "Запросить удаление"}
                              </Button>
                            </div>
                          </Space>
                        ),
                      };
                    })}
                  />
                )}
              </Card>
            ),
          },
          {
            key: "stock",
            label: "Остатки и резерв",
            children: (
              <Card>
                <Typography.Paragraph type="secondary">
                  Резерв — сколько из остатка уже нужно текущим (незавершённым) заданиям цеха, но ещё не заказано
                  отдельно. Доступно = остаток минус резерв.
                </Typography.Paragraph>
                {stockSupplierFilter && (
                  <Space style={{ marginBottom: 12 }}>
                    <Tag color="purple">Только «{stockSupplierFilter}»</Tag>
                    <Button size="small" onClick={() => setStockSupplierFilter(null)}>
                      Сбросить фильтр
                    </Button>
                  </Space>
                )}
                <ResponsiveTable<StockOverviewLine>
                  tableKey="purchasing-stock-overview"
                  lockedColumns={["Позиция"]}
                  rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
                  loading={stockOverviewQuery.isLoading}
                  dataSource={stockRows}
                  pagination={{ pageSize: 20 }}
                  scroll={{ x: "max-content" }}
                  columns={[
                    { title: "Позиция", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
                    { title: "Остаток, м²", dataIndex: "total_area_m2" },
                    { title: "Резерв на задания, м²", dataIndex: "reserved_area_m2" },
                    {
                      title: "Доступно, м²",
                      render: (_, r) => {
                        const available = round1(r.total_area_m2 - r.reserved_area_m2);
                        return <Tag color={available < 0 ? "red" : available < r.reserved_area_m2 * 0.2 ? "gold" : "green"}>{available}</Tag>;
                      },
                    },
                    {
                      title: "В заявках",
                      dataIndex: "open_requested_area_m2",
                      render: (v: number) => (v > 0 ? <Tag color="purple">{v} м²</Tag> : "—"),
                    },
                    { title: "Обычно берут у", dataIndex: "usual_supplier", render: (v: string | null) => v ?? "—" },
                    {
                      title: "",
                      render: (_, r) => (
                        <Button
                          size="small"
                          onClick={() => {
                            setPrefill({ material: r.material, color: r.color, thickness: r.thickness });
                            setCreateOpen(true);
                          }}
                        >
                          Заказать
                        </Button>
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
                    tableKey="supplier-stats"
                    lockedColumns={["Поставщик"]}
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
                      {
                        title: "",
                        render: (_, s) => (
                          <Button size="small" onClick={() => openStockForSupplier(s.supplier_name)}>
                            Остатки по его плёнкам →
                          </Button>
                        ),
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
        title={`Поставщик и цена — ${editingPrice?.label ?? ""}`}
        open={!!editingPrice}
        onCancel={() => setEditingPrice(null)}
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

      <Modal
        title="Новый заказ поставщику"
        open={orderModalOpen}
        onCancel={() => setOrderModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Space direction="vertical" size="small" style={{ width: "100%", marginBottom: 16 }}>
          {selectedLines.map((line, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px dashed #E2DFD6", paddingBottom: 6 }}>
              <span>
                {line.material}, {line.color}, {line.thickness} мм
              </span>
              <span>{line.total} м²</span>
            </div>
          ))}
        </Space>
        <Form
          layout="vertical"
          form={orderForm}
          onFinish={(v) => createOrderMutation.mutate({ ...v, request_ids: Array.from(selectedIds) })}
        >
          <Form.Item name="supplier" label="Поставщик" rules={[{ required: true }]}>
            <DictAutoComplete kind="suppliers" />
          </Form.Item>
          <Form.Item name="note" label="Комментарий (необязательно)">
            <Input placeholder="Например: срочно, две линии простаивают" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createOrderMutation.isPending}>
            Создать заказ
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
