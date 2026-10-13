import { ReorderTab } from "./Reports";
import { useEffect, useState } from "react";
import { Card, Tag, Button, Modal, Form, InputNumber, Input, DatePicker, Space, Typography, Empty, Tabs, Checkbox, Collapse, message } from "antd";
import dayjs from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import ResponsiveTable from "../../components/ResponsiveTable";
import { exportToExcel } from "../../utils/excel";

import {
  listPurchaseRequests,
  createPurchaseRequest,
  updatePurchaseRequest,
  closePurchaseRequest,
  deletePurchaseRequest,
  deleteSupplierOrder,
  listSupplierOrders,
  createSupplierOrder,
  purchaseLabel,
  purchaseQty,
  receiveItemPurchaseRequest,
  type PurchaseRequest,
  type PurchaseRequestCreate,
  type PurchaseRequestUpdate,
  type SupplierOrder,
} from "../../api/purchasing";
import { getSupplierStats, type SupplierStats } from "../../api/suppliers";
import DictAutoComplete from "../../components/DictAutoComplete";
import ItemPurchaseModal from "../../components/ItemPurchaseModal";
import PanelFilmTable from "../../components/PanelFilmTable";
import { useAuth } from "../../auth/AuthContext";
import { apiErrorMessage } from "../../utils/apiError";
import { fmtDate } from "../../utils/dates";
import { FileExcelOutlined } from "@ant-design/icons";

interface EditingPriceTarget {
  requestIds: number[];
  label: string;
  supplier?: string | null;
  price_per_m2?: number | null;
  /** единица цены: у плёнки м², у материала — его единица (14.10) */
  unit?: string | null;
}

/** Экран снабженца — три вкладки: "Заявки поставщику" (чекбоксы и
 * объединение в заказ), "Заказы поставщикам" (результат объединения) и
 * "Поставщики" (история цен/сроков). "Остатки и резерв" отсюда убраны —
 * дублировали таблицу "Остатки" (MaterialsExplorer.tsx) без её фильтров;
 * резерв/заявки/дозаказ/"Заказать" теперь там же, кнопка "Заказать"
 * приводит сюда уже с открытой формой (см. useEffect на location.state
 * ниже), "Остатки по его плёнкам →" с "Поставщиков" — туда же, с
 * фильтром по обычному поставщику. */
export default function Purchasing() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [tabParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(tabParams.get("tab") ?? "requests");
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<Partial<PurchaseRequestCreate> | null>(null);
  const [editingPrice, setEditingPrice] = useState<EditingPriceTarget | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [onlyUngrouped, setOnlyUngrouped] = useState(false);
  const [showClosedRequests, setShowClosedRequests] = useState(false);
  const [showClosedOrders, setShowClosedOrders] = useState(false);
  const [itemBuyOpen, setItemBuyOpen] = useState(false);
  const [receiving, setReceiving] = useState<PurchaseRequest | null>(null);
  const [receiveForm] = Form.useForm<{ quantity: number; doc?: string; price?: number; close: boolean }>();
  const [form] = Form.useForm<PurchaseRequestCreate>();
  const [editForm] = Form.useForm<PurchaseRequestUpdate>();
  const [orderForm] = Form.useForm<{ supplier: string; note?: string }>();

  const requestsQuery = useQuery({ queryKey: ["purchase-requests"], queryFn: () => listPurchaseRequests() });
  const supplierStatsQuery = useQuery({ queryKey: ["supplier-stats"], queryFn: getSupplierStats });
  const ordersQuery = useQuery({ queryKey: ["supplier-orders"], queryFn: listSupplierOrders });

  // Раздел про объединение "Остатков и резерва" с основной таблицей
  // остатков ("Остатки" — MaterialsExplorer.tsx, кнопка "Заказать") —
  // раньше отдельная вкладка здесь дублировала ту же таблицу без
  // фильтров; теперь сюда только приходят с готовой позицией.
  useEffect(() => {
    const s = location.state as Partial<PurchaseRequestCreate> | null;
    if (s?.material) {
      setPrefill(s);
      setCreateOpen(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

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
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить заявку")),
  });

  const deleteOrderMutation = useMutation({
    mutationFn: (id: number) => deleteSupplierOrder(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-orders"] });
      message.success(result.requested ? "Заявка на удаление отправлена администратору" : "Заказ удалён");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить заказ")),
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

  // Поставка по заявке на материал (14.10): приход на склад и закрытие заявки
  const receiveMutation = useMutation({
    mutationFn: (v: { quantity: number; doc?: string; price?: number; close: boolean }) => receiveItemPurchaseRequest(receiving!.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-orders"] });
      qc.invalidateQueries({ queryKey: ["material-stock"] });
      qc.invalidateQueries({ queryKey: ["material-demand"] });
      setReceiving(null);
      message.success("Приход записан на склад");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось записать поставку")),
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

  const [requestSearch, setRequestSearch] = useState("");
  const selectableRows = (requestsQuery.data ?? []).filter((r) => r.status === "open" && r.order_id === null);
  const requestSearchNeedle = requestSearch.trim().toLowerCase();
  const visibleRequests = (requestsQuery.data ?? [])
    .filter((r) => !onlyUngrouped || r.order_id === null)
    .filter((r) => showClosedRequests || r.status !== "closed")
    .filter((r) => {
      if (!requestSearchNeedle) return true;
      const haystack = [r.material ?? "", r.color ?? "", r.item_name ?? "", r.supplier ?? "", r.note ?? ""].join(" ").toLowerCase();
      return haystack.includes(requestSearchNeedle);
    });
  const visibleOrders = (ordersQuery.data ?? []).filter((o) => showClosedOrders || o.is_open);
  const selectedRequests = selectableRows.filter((r) => selectedIds.has(r.id));
  const selectedLines = (() => {
    const byKey = new Map<string, { label: string; total: number; unit: string }>();
    for (const r of selectedRequests) {
      const key = purchaseLabel(r);
      const q = r.item_name ? r.quantity ?? 0 : r.requested_area_m2 ?? 0;
      const existing = byKey.get(key);
      if (existing) existing.total += q;
      else byKey.set(key, { label: key, total: q, unit: r.item_name ? r.unit ?? "" : "м²" });
    }
    return Array.from(byKey.values());
  })();

  const openStockForSupplier = (supplierName: string) => {
    navigate("/stock", { state: { usualSupplierFilter: supplierName } });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          // «Пора заказывать» — перенесено из «Отчётов» (30.09): сигнал для закупщика.
          { key: "reorder", label: "Пора заказывать", children: <ReorderTab /> },
          {
            key: "requests",
            label: "Заявки поставщику",
            children: (
              <Card
                extra={
                  <Space>
                    <Button
                      icon={<FileExcelOutlined />}
                      onClick={() =>
                        exportToExcel(
                          "zayavki-postavshchiku.xlsx",
                          visibleRequests.map((r) => ({
                            material: purchaseLabel(r),
                            requested_area_m2: purchaseQty(r),
                            current_stock_m2: r.item_name ? `${r.current_stock ?? 0} ${r.unit ?? ""}` : r.current_stock_m2,
                            supplier: r.supplier ?? "",
                            price_per_m2: (r.item_name ? r.price_per_unit : r.price_per_m2) ?? "",
                            note: r.note ?? "",
                            status: r.status === "open" ? "Открыта" : "Закрыта",
                            created_at: fmtDate(r.created_at),
                          })),
                          [
                            { key: "material", header: "Материал" },
                            { key: "requested_area_m2", header: "Запрошено" },
                            { key: "current_stock_m2", header: "Остаток на складе" },
                            { key: "supplier", header: "Поставщик" },
                            { key: "price_per_m2", header: "Цена, ₽ за ед. (плёнка — за м²)" },
                            { key: "note", header: "Комментарий" },
                            { key: "status", header: "Статус" },
                            { key: "created_at", header: "Создана" },
                          ],
                        )
                      }
                    >
                      Excel
                    </Button>
                    <Button onClick={() => setItemBuyOpen(true)}>Заявка на материал</Button>
                    <Button
                      type="primary"
                      onClick={() => {
                        setPrefill(null);
                        setCreateOpen(true);
                      }}
                    >
                      Заявка на плёнку
                    </Button>
                  </Space>
                }
              >
                <Space style={{ marginBottom: 12 }}>
                  <Button size="small" type={onlyUngrouped ? "default" : "primary"} ghost={onlyUngrouped} onClick={() => setOnlyUngrouped(false)}>
                    Все
                  </Button>
                  <Button size="small" type={onlyUngrouped ? "primary" : "default"} ghost={!onlyUngrouped} onClick={() => setOnlyUngrouped(true)}>
                    Не в заказе
                  </Button>
                  <Checkbox checked={showClosedRequests} onChange={(e) => setShowClosedRequests(e.target.checked)}>
                    Показывать закрытые
                  </Checkbox>
                  <Input.Search
                    allowClear
                    placeholder="Поиск — материал, цвет, поставщик, комментарий…"
                    style={{ width: 280 }}
                    value={requestSearch}
                    onChange={(e) => setRequestSearch(e.target.value)}
                  />
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
                    {
                      title: "Материал",
                      render: (_, r) =>
                        r.item_name ? (
                          <Space size={4}>
                            {r.item_name}
                            <Tag>материал</Tag>
                          </Space>
                        ) : (
                          purchaseLabel(r)
                        ),
                    },
                    { title: "Запрошено", render: (_, r) => purchaseQty(r) },
                    {
                      title: "Остаток на складе",
                      render: (_, r) => (r.item_name ? `${r.current_stock ?? 0} ${r.unit ?? ""}` : `${r.current_stock_m2 ?? 0} м²`),
                    },
                    { title: "Поставщик", dataIndex: "supplier", render: (v: string | null) => v ?? "—" },
                    {
                      title: "Цена, ₽/м²",
                      render: (_, r) =>
                        r.item_name ? (r.price_per_unit != null ? `${r.price_per_unit} за ${r.unit ?? "ед."}` : "—") : r.price_per_m2 ?? "—",
                    },
                    {
                      title: "Нужно к",
                      dataIndex: "need_by",
                      render: (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "—"),
                    },
                    { title: "Комментарий", dataIndex: "note", render: (v: string | null) => v ?? "—" },
                    {
                      title: "Происхождение",
                      dataIndex: "origin",
                      render: (v: string) =>
                        v === "shop_floor" ? <Tag color="blue">С цеха</Tag> : v === "needs" ? <Tag color="purple">Дефицит по заказам</Tag> : <Tag>Плановая</Tag>,
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
                      render: (v: string) => fmtDate(v),
                    },
                    {
                      title: "",
                      render: (_, r) => (
                        <Space>
                          <Button
                            size="small"
                            onClick={() => {
                              const price = r.item_name ? r.price_per_unit : r.price_per_m2;
                              setEditingPrice({
                                requestIds: [r.id],
                                label: `заявка №${r.id}`,
                                supplier: r.supplier,
                                price_per_m2: price,
                                unit: r.item_name ? r.unit ?? "ед." : "м²",
                              });
                              editForm.setFieldsValue({
                                supplier: r.supplier ?? undefined,
                                price_per_m2: price ?? undefined,
                                promised_delivery_date: r.promised_delivery_date ?? undefined,
                              });
                            }}
                          >
                            Поставщик/цена
                          </Button>
                          {r.status === "open" && r.item_name && (
                            <Button
                              size="small"
                              type="primary"
                              onClick={() => {
                                setReceiving(r);
                                receiveForm.setFieldsValue({ quantity: r.quantity ?? undefined, doc: undefined, price: r.price_per_unit ?? undefined, close: true });
                              }}
                            >
                              Поступило
                            </Button>
                          )}
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
              <Card
                extra={
                  <Space>
                    <Button
                      icon={<FileExcelOutlined />}
                      onClick={() =>
                        exportToExcel(
                          "zakazy-postavshchikam.xlsx",
                          visibleOrders.flatMap((order) =>
                            order.lines.map((line) => ({
                              order_id: order.id,
                              status: order.is_open ? "Открыт" : "Закрыт",
                              supplier: order.supplier,
                              created_at: fmtDate(order.created_at),
                              material: purchaseLabel(line),
                              requested_area_m2: purchaseQty(line),
                              current_stock_m2: line.item_name ? "" : line.current_stock_m2,
                              request_count: line.request_ids.length,
                            })),
                          ),
                          [
                            { key: "order_id", header: "№ заказа" },
                            { key: "status", header: "Статус" },
                            { key: "supplier", header: "Поставщик" },
                            { key: "created_at", header: "Создан" },
                            { key: "material", header: "Материал" },
                            { key: "requested_area_m2", header: "Запрошено" },
                            { key: "current_stock_m2", header: "Остаток плёнки на складе, м²" },
                            { key: "request_count", header: "Из заявок" },
                          ],
                        )
                      }
                    >
                      Excel
                    </Button>
                    <Checkbox checked={showClosedOrders} onChange={(e) => setShowClosedOrders(e.target.checked)}>
                      Показывать закрытые
                    </Checkbox>
                  </Space>
                }
              >
                {visibleOrders.length === 0 ? (
                  <Empty description="Заказов пока нет — объедините заявки на вкладке «Заявки поставщику»" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  <Collapse
                    items={visibleOrders.map((order: SupplierOrder) => {
                      const totalArea = order.lines.reduce((sum, l) => sum + (l.requested_area_m2 ?? 0), 0);
                      return {
                        key: order.id,
                        label: (
                          <Space wrap>
                            {order.is_open ? <Tag color="orange">Открыт</Tag> : <Tag color="green">Закрыт</Tag>}
                            <Typography.Text strong>{order.supplier}</Typography.Text>
                            <Typography.Text type="secondary">
                              {order.lines.length} {order.lines.length === 1 ? "позиция" : "позиций"}
                              {totalArea > 0 ? ` · плёнки ${totalArea.toFixed(1)} м²` : ""} ·{" "}
                              {fmtDate(order.created_at)}
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
                                  <div>{purchaseLabel(line)}</div>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    {line.item_name ? "" : `остаток на складе ${line.current_stock_m2} м² · `}из {line.request_ids.length}{" "}
                                    {line.request_ids.length === 1 ? "заявки" : "заявок"}
                                  </Typography.Text>
                                </div>
                                <Space>
                                  <span>{purchaseQty(line)}</span>
                                  <Button
                                    size="small"
                                    onClick={() => {
                                      setEditingPrice({
                                        requestIds: line.request_ids,
                                        label: purchaseLabel(line),
                                        supplier: order.supplier,
                                        price_per_m2: null,
                                        unit: line.item_name ? line.unit ?? "ед." : "м²",
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
            key: "panel-film",
            label: "Плёнка под двери",
            children: <PanelFilmTable />,
          },
          {
            key: "suppliers",
            label: "Поставщики",
            children: (
              <Card
                extra={
                  (supplierStatsQuery.data ?? []).length > 0 && (
                    <Button
                      icon={<FileExcelOutlined />}
                      onClick={() =>
                        exportToExcel(
                          "postavshchiki.xlsx",
                          (supplierStatsQuery.data ?? []).map((s) => ({
                            supplier_name: s.supplier_name,
                            closed_requests: s.closed_requests,
                            avg_price_per_m2: s.avg_price_per_m2 ?? "",
                            avg_lead_time_days: s.avg_lead_time_days ?? "",
                            avg_delivery_variance_days: s.avg_delivery_variance_days ?? "",
                            last_request_at: fmtDate(s.last_request_at),
                          })),
                          [
                            { key: "supplier_name", header: "Поставщик" },
                            { key: "closed_requests", header: "Закрыто заявок" },
                            { key: "avg_price_per_m2", header: "Средняя цена, ₽/м²" },
                            { key: "avg_lead_time_days", header: "Средний срок, дней" },
                            { key: "avg_delivery_variance_days", header: "Отклонение от срока, дн." },
                            { key: "last_request_at", header: "Последняя заявка" },
                          ],
                        )
                      }
                    >
                      Excel
                    </Button>
                  )
                }
              >
                <Typography.Paragraph type="secondary">
                  Средняя цена, фактический срок поставки (закрытие минус создание заявки) и отклонение от
                  обещанной даты (там, где она указывалась) — только по закрытым заявкам с указанным поставщиком.
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
                        title: "Отклонение от срока, дн.",
                        dataIndex: "avg_delivery_variance_days",
                        render: (v: number | null) =>
                          v == null ? "—" : <span style={{ color: v > 0 ? "#C97A2B" : undefined }}>{v > 0 ? `+${v}` : v}</span>,
                        sorter: (a, b) => (a.avg_delivery_variance_days ?? 0) - (b.avg_delivery_variance_days ?? 0),
                      },
                      {
                        title: "Последняя заявка",
                        dataIndex: "last_request_at",
                        render: (v: string) => fmtDate(v),
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
          <Form.Item
            name="promised_delivery_date"
            label="Обещали привезти к (опционально)"
            getValueProps={(v: string | undefined) => ({ value: v ? dayjs(v) : undefined })}
            normalize={(v: dayjs.Dayjs | null) => v?.format("YYYY-MM-DD")}
          >
            <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
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
          <Form.Item name="price_per_m2" label={`Цена, ₽/${editingPrice?.unit ?? "м²"}`}>
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="promised_delivery_date"
            label="Обещали привезти к"
            getValueProps={(v: string | undefined) => ({ value: v ? dayjs(v) : undefined })}
            normalize={(v: dayjs.Dayjs | null) => v?.format("YYYY-MM-DD")}
          >
            <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
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
              <span>{line.label}</span>
              <span>
                {Math.round(line.total * 1000) / 1000} {line.unit}
              </span>
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

      <ItemPurchaseModal open={itemBuyOpen} onClose={() => setItemBuyOpen(false)} />

      <Modal
        title={receiving ? `Поступило: ${receiving.item_name} (заявка №${receiving.id})` : ""}
        open={!!receiving}
        onCancel={() => setReceiving(null)}
        onOk={() => receiveForm.submit()}
        okText="Записать приход"
        confirmLoading={receiveMutation.isPending}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Приход на склад материалов с документом и ценой; заявка закрывается. Пришло не всё — снимите галочку, заявка останется открытой.
        </Typography.Paragraph>
        <Form form={receiveForm} layout="vertical" onFinish={(v) => receiveMutation.mutate(v)}>
          <Form.Item name="quantity" label={`Пришло, ${receiving?.unit ?? ""}`} rules={[{ required: true, message: "Сколько пришло" }]}>
            <InputNumber min={0.001} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="doc" label="УПД / накладная">
            <Input />
          </Form.Item>
          <Form.Item name="price" label={`Цена, ₽ за ${receiving?.unit ?? "ед."} (по УПД)`}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="close" valuePropName="checked">
            <Checkbox>Закрыть заявку</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
