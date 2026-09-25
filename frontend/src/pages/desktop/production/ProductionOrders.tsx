import { useState } from "react";
import { isAxiosError } from "axios";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Card,
  Checkbox,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import ScheduleImportModal from "./ScheduleImportModal";
import { useAuth } from "../../../auth/AuthContext";
import { listItems } from "../../../api/items";
import {
  ORDER_STATUS_LABEL,
  closeProductionOrder,
  createProductionOrder,
  deleteProductionOrder,
  listProductionOrders,
  releaseProductionOrder,
  updateProductionOrder,
  type OrderInput,
  type OrderStatus,
  type ProductionOrder,
} from "../../../api/productionOrders";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const STATUS_COLOR: Record<OrderStatus, string> = { draft: "default", released: "blue", closed: "green" };

const orderTotals = (o: ProductionOrder) => {
  const qty = o.lines.reduce((s, l) => s + l.quantity, 0);
  const done = o.lines.reduce((s, l) => s + Math.min(l.done, l.quantity), 0);
  return { qty, done };
};

/** Заказы на производство (единая модель, пункт 4): что и сколько сделать —
 * позиции любого вида. «Запустить» раскладывает заказ по маршрутам позиций
 * на задания участкам («Задания цеха»); комплектующие — через «Потребность
 * п/ф»; прогресс — по отчётам участков. */
export default function ProductionOrders() {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const [includeClosed, setIncludeClosed] = useState(false);
  // ?order=ID (сквозной поиск по номеру) — сразу открыть карточку заказа.
  const [params] = useSearchParams();
  const [openId, setOpenId] = useState<number | null>(Number(params.get("order")) || null);
  const [editing, setEditing] = useState<ProductionOrder | "new" | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [includeClosedDefault] = useState(!!params.get("order"));
  const ordersQuery = useQuery({
    queryKey: ["production-orders", includeClosed || includeClosedDefault],
    queryFn: () => listProductionOrders(includeClosed || includeClosedDefault),
  });
  const opened = (ordersQuery.data ?? []).find((o) => o.id === openId) ?? null;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="Заказы на производство"
        extra={
          <Space>
            <Checkbox checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)}>
              С закрытыми
            </Checkbox>
            {canManage && <Button onClick={() => setImportOpen(true)}>Из графика…</Button>}
            {canManage && (
              <Button type="primary" onClick={() => setEditing("new")}>
                Новый заказ
              </Button>
            )}
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Что и сколько сделать — любые позиции номенклатуры. «Запустить» раскладывает заказ по маршрутам позиций на
          задания участкам; комплектующие п/ф попадают в «Потребность п/ф»; отчёт по операции списывает комплектующие,
          которые на ней расходуются.
        </Typography.Paragraph>
      </Card>
      <ResponsiveTable<ProductionOrder>
        tableKey="production-orders"
        lockedColumns={["Заказ"]}
        size="small"
        rowKey="id"
        loading={ordersQuery.isLoading}
        dataSource={ordersQuery.data ?? []}
        pagination={{ pageSize: 30 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Заказов пока нет" }}
        onRow={(o) => ({ onClick: () => setOpenId(o.id), style: { cursor: "pointer" } })}
        columns={[
          {
            title: "Заказ",
            render: (_, o) => (
              <Space direction="vertical" size={0}>
                <span>
                  №{o.id} «{o.name}»
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {o.lines.length} поз.: {o.lines.slice(0, 2).map((l) => l.item_name).join(", ")}
                  {o.lines.length > 2 ? " …" : ""}
                </Typography.Text>
              </Space>
            ),
          },
          { title: "Статус", render: (_, o) => <Tag color={STATUS_COLOR[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Tag> },
          { title: "Отгрузка", render: (_, o) => (o.ship_date ? dayjs(o.ship_date).format("DD.MM.YYYY") : "—") },
          {
            title: "Готово",
            render: (_, o) => {
              const { qty, done } = orderTotals(o);
              return o.status === "draft" ? (
                <Typography.Text type="secondary">{qty} шт</Typography.Text>
              ) : (
                <Space size={8}>
                  <Progress percent={qty ? Math.round((done / qty) * 100) : 0} size="small" style={{ width: 120 }} />
                  <span>
                    {done} из {qty}
                  </span>
                </Space>
              );
            },
          },
          { title: "Создал", render: (_, o) => `${o.created_by_name}, ${dayjs(o.created_at).format("DD.MM.YYYY")}` },
        ]}
      />
      <OrderDrawer order={opened} onClose={() => setOpenId(null)} onEdit={(o) => setEditing(o)} canManage={canManage} />
      {importOpen && (
        <ScheduleImportModal
          onClose={() => setImportOpen(false)}
          onCreated={(o) => {
            setImportOpen(false);
            setOpenId(o.id);
          }}
        />
      )}
      {editing && (
        <OrderModal
          order={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(o) => {
            setEditing(null);
            setOpenId(o.id);
          }}
        />
      )}
    </Space>
  );
}

function OrderDrawer({
  order,
  onClose,
  onEdit,
  canManage,
}: {
  order: ProductionOrder | null;
  onClose: () => void;
  onEdit: (o: ProductionOrder) => void;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["production-orders"] });
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
    qc.invalidateQueries({ queryKey: ["pf-demand"] });
  };
  const releaseMutation = useMutation({
    mutationFn: (id: number) => releaseProductionOrder(id),
    onSuccess: (o) => {
      invalidate();
      message.success(`Заказ запущен: заданий участкам — ${o.task_ids.length}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось запустить заказ")),
  });
  const closeMutation = useMutation({
    mutationFn: (id: number) => closeProductionOrder(id),
    onSuccess: () => {
      invalidate();
      message.success("Заказ закрыт");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось закрыть заказ")),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteProductionOrder(id),
    onSuccess: () => {
      invalidate();
      message.success("Черновик удалён");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить")),
  });

  return (
    <Drawer
      open={!!order}
      onClose={onClose}
      width={880}
      title={
        order && (
          <Space>
            <span>
              Заказ №{order.id} «{order.name}»
            </span>
            <Tag color={STATUS_COLOR[order.status]}>{ORDER_STATUS_LABEL[order.status]}</Tag>
          </Space>
        )
      }
      extra={
        order &&
        canManage && (
          <Space>
            {order.status === "draft" && (
              <>
                <Button onClick={() => onEdit(order)}>Изменить</Button>
                <Popconfirm title="Удалить черновик?" okText="Удалить" cancelText="Отмена" onConfirm={() => deleteMutation.mutate(order.id)}>
                  <Button danger>Удалить</Button>
                </Popconfirm>
                <Popconfirm
                  title="Запустить заказ?"
                  description="Появятся задания участкам по маршрутам позиций; после запуска заказ не правится."
                  okText="Запустить"
                  cancelText="Отмена"
                  onConfirm={() => releaseMutation.mutate(order.id)}
                >
                  <Button type="primary" loading={releaseMutation.isPending}>
                    Запустить
                  </Button>
                </Popconfirm>
              </>
            )}
            {order.status === "released" && (
              <>
                <Button onClick={() => navigate("/production-tasks")}>Задания цеха →</Button>
                <Button onClick={() => navigate("/pf-demand")}>Потребность п/ф →</Button>
                <Popconfirm
                  title="Закрыть заказ?"
                  description="Задания заказа уйдут в архив."
                  okText="Закрыть"
                  cancelText="Отмена"
                  onConfirm={() => closeMutation.mutate(order.id)}
                >
                  <Button loading={closeMutation.isPending}>Закрыть</Button>
                </Popconfirm>
              </>
            )}
          </Space>
        )
      }
    >
      {order && (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {order.ship_date ? `Отгрузка ${dayjs(order.ship_date).format("DD.MM.YYYY")}. ` : ""}
            {order.note ?? ""}
          </Typography.Text>
          {order.lines.map((l) => (
            <Card
              key={l.id}
              size="small"
              title={
                <Space wrap>
                  <span>{l.item_name}</span>
                  <Tag>{l.kind_name}</Tag>
                </Space>
              }
              extra={
                <Typography.Text strong>
                  {order.status === "draft" ? `${l.quantity} шт` : `готово ${l.done} из ${l.quantity}`}
                </Typography.Text>
              }
            >
              <Space direction="vertical" style={{ width: "100%" }}>
                {l.operations.length === 0 ? (
                  <Typography.Text type="warning">Нет маршрута — задайте его в техкарте позиции, иначе заказ не запустится.</Typography.Text>
                ) : (
                  <Table
                    size="small"
                    rowKey="stage_id"
                    pagination={false}
                    dataSource={l.operations}
                    columns={[
                      { title: "Операция", dataIndex: "name" },
                      { title: "Участок", render: (_, op) => op.area_name ?? "—" },
                      {
                        title: "Сделано",
                        render: (_, op) =>
                          order.status === "draft" ? (
                            "—"
                          ) : (
                            <Space size={8}>
                              <Progress percent={Math.round((Math.min(op.good, l.quantity) / l.quantity) * 100)} size="small" style={{ width: 100 }} />
                              <span>
                                {op.good} из {l.quantity}
                              </span>
                            </Space>
                          ),
                      },
                      { title: "Брак", render: (_, op) => (op.defect ? <Typography.Text type="danger">{op.defect}</Typography.Text> : "—") },
                    ]}
                  />
                )}
                {l.components.length > 0 && (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      КОМПЛЕКТУЮЩИЕ НА ЗАКАЗ
                    </Typography.Text>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                      {l.components.map((c) => (
                        <li key={c.item_id}>
                          {c.name} — {c.total} {c.unit}
                          <Typography.Text type="secondary">
                            {" "}
                            ({c.per_unit} на 1 шт{c.operation_name ? `, на «${c.operation_name}»` : ""})
                          </Typography.Text>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Space>
            </Card>
          ))}
        </Space>
      )}
    </Drawer>
  );
}

type LineDraft = { item_id: number | null; quantity: number | null; note: string };

function OrderModal({
  order,
  onClose,
  onSaved,
}: {
  order: ProductionOrder | null;
  onClose: () => void;
  onSaved: (o: ProductionOrder) => void;
}) {
  const qc = useQueryClient();
  const itemsQuery = useQuery({ queryKey: ["items", false], queryFn: () => listItems({ include_inactive: false }) });
  const [name, setName] = useState(order?.name ?? "");
  const [shipDate, setShipDate] = useState<Dayjs | null>(order?.ship_date ? dayjs(order.ship_date) : null);
  const [note, setNote] = useState(order?.note ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    order ? order.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity, note: l.note ?? "" })) : [{ item_id: null, quantity: null, note: "" }],
  );
  const patch = (i: number, p: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const itemOptions = (itemsQuery.data ?? [])
    .filter((i) => i.kind_code !== "plenka" && !i.is_model) // модель — не в заказ, берётся её вариант
    .map((i) => ({ value: i.id, label: `${i.name} · ${i.kind_name}` }));

  const mutation = useMutation({
    mutationFn: () => {
      const payload: OrderInput = {
        name: name.trim(),
        ship_date: shipDate ? shipDate.format("YYYY-MM-DD") : null,
        note: note.trim() || null,
        lines: lines.map((l) => ({ item_id: l.item_id as number, quantity: l.quantity as number, note: l.note.trim() || null })),
      };
      return order ? updateProductionOrder(order.id, payload) : createProductionOrder(payload);
    },
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      message.success(order ? "Заказ сохранён" : "Черновик заказа создан");
      onSaved(o);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить заказ")),
  });
  const invalid = !name.trim() || lines.length === 0 || lines.some((l) => !l.item_id || !l.quantity || l.quantity <= 0);

  return (
    <Modal
      open
      width={820}
      title={order ? `Заказ №${order.id}` : "Новый заказ на производство"}
      okText={order ? "Сохранить" : "Создать черновик"}
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ disabled: invalid, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
    >
      <Form layout="vertical">
        <Space size={12} style={{ display: "flex" }} wrap>
          <Form.Item label="Название" required style={{ width: 360 }}>
            <Input value={name} placeholder="Например: Запуск 16.09" onChange={(e) => setName(e.target.value)} />
          </Form.Item>
          <Form.Item label="Отгрузка">
            <DatePicker format="DD.MM.YYYY" value={shipDate} onChange={setShipDate} />
          </Form.Item>
        </Space>
        <Form.Item label="Комментарий">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Form.Item>
        <Typography.Text strong>Позиции</Typography.Text>
        {itemOptions.length === 0 && !itemsQuery.isLoading ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет позиций" />
        ) : (
          <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
            {lines.map((l, i) => (
              <Space key={i} wrap>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Позиция (изделие или п/ф)"
                  style={{ width: 420 }}
                  loading={itemsQuery.isLoading}
                  value={l.item_id ?? undefined}
                  options={itemOptions}
                  onChange={(v) => patch(i, { item_id: v })}
                />
                <InputNumber min={1} placeholder="шт" style={{ width: 100 }} value={l.quantity} onChange={(v) => patch(i, { quantity: v })} />
                <Input placeholder="примечание" style={{ width: 160 }} value={l.note} onChange={(e) => patch(i, { note: e.target.value })} />
                {lines.length > 1 && (
                  <Button size="small" danger onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    Убрать
                  </Button>
                )}
              </Space>
            ))}
            <Button onClick={() => setLines((ls) => [...ls, { item_id: null, quantity: null, note: "" }])}>+ позиция</Button>
          </Space>
        )}
      </Form>
    </Modal>
  );
}
