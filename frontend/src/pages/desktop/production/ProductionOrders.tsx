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
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Segmented,
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
import CreateTaskModal from "./CreateTaskModal";
import OperationTaskModal from "./OperationTaskModal";
import PfSupplyModal from "./PfSupplyModal";
import ReleaseOrderModal from "./ReleaseOrderModal";
import FastReportPanel from "./fastReport/FastReportPanel";
import TaskCardDrawer from "./TaskCardDrawer";
import VariantPicker from "../../../components/VariantPicker";
import { useAuth } from "../../../auth/AuthContext";
import { listItems, type Item } from "../../../api/items";
import {
  ORDER_STATUS_LABEL,
  closeProductionOrder,
  completeProductionOrder,
  createProductionOrder,
  deleteProductionOrder,
  listProductionOrders,
  rescheduleOrder,
  updateProductionOrder,
  type OrderKind,
  type OrderInput,
  type OrderStatus,
  type OrderTask,
  type ProductionOrder,
} from "../../../api/productionOrders";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const STATUS_COLOR: Record<OrderStatus, string> = { draft: "default", released: "blue", closed: "green" };

// Заказ с позициями — готовность по последней операции позиций; заказ
// из заданий (окутка из наряда, операции участка, п/ф) — по строкам заданий.
const orderTotals = (o: ProductionOrder) => {
  if (o.lines.length === 0) {
    const tasks = o.tasks ?? [];
    return { qty: tasks.reduce((s, t) => s + t.planned, 0), done: tasks.reduce((s, t) => s + t.done, 0) };
  }
  const qty = o.lines.reduce((s, l) => s + l.quantity, 0);
  const done = o.lines.reduce((s, l) => s + Math.min(l.done, l.quantity), 0);
  return { qty, done };
};

/** Как в заказе создаётся задание участку: с плёнкой или без. */
type TaskCreate = { kind: "film" | "ops"; orderId?: number };

/** Заказы на производство — единственное место, где заводится работа
 * цеху (как в ERP: заказ → задания на участки). Заказ из позиций
 * номенклатуры «Запустить» раскладывает по маршрутам; окутка/ламинация из
 * наряда или плана заготовок и работы участка без плёнки — сразу заказ с
 * заданием. «Задания цеха» — только исполнение. Комплектующие п/ф — через
 * «Обеспечение п/ф» задания и «Потребность п/ф». */
export default function ProductionOrders() {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const [includeClosed, setIncludeClosed] = useState(false);
  // ?order=ID (сквозной поиск по номеру) — сразу открыть карточку заказа.
  const [params] = useSearchParams();
  const [openId, setOpenId] = useState<number | null>(Number(params.get("order")) || null);
  const [editing, setEditing] = useState<ProductionOrder | "new" | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [taskCreate, setTaskCreate] = useState<TaskCreate | null>(null);
  const [supplyTarget, setSupplyTarget] = useState<{ id: number; name: string } | null>(null);
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
            {canManage && (
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    { key: "film", label: "Окутка / ламинация — из наряда, плана заготовок или вручную" },
                    { key: "ops", label: "Работы участка без плёнки (операции техкарт)" },
                    { key: "items", label: "Из позиций номенклатуры (по маршрутам)" },
                    { key: "schedule", label: "Из графика запуска…" },
                  ],
                  onClick: ({ key }) => {
                    if (key === "film" || key === "ops") setTaskCreate({ kind: key });
                    else if (key === "items") setEditing("new");
                    else setImportOpen(true);
                  },
                }}
              >
                <Button type="primary">Новый заказ ▾</Button>
              </Dropdown>
            )}
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Вся работа цеху заводится здесь. Заказ из позиций номенклатуры «Запустить» раскладывает по маршрутам на
          задания участкам; окутка из наряда или плана заготовок и работы без плёнки — сразу заказ с заданием. Участки
          выполняют задания в «Заданиях цеха».
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
                  №{o.id} «{o.name}» {o.kind === "stock" && <Tag color="green">на склад</Tag>}
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {o.lines.length > 0 ? (
                    <>
                      {o.lines.length} поз.: {o.lines.slice(0, 2).map((l) => l.item_name).join(", ")}
                      {o.lines.length > 2 ? " …" : ""}
                    </>
                  ) : (
                    `заданий: ${(o.tasks ?? []).length} · ${[...new Set((o.tasks ?? []).map((t) => t.area_name ?? t.area))].join(", ")}`
                  )}
                </Typography.Text>
              </Space>
            ),
          },
          { title: "Статус", render: (_, o) => <Tag color={STATUS_COLOR[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Tag> },
          {
            title: "Отгрузка / готово к",
            render: (_, o) => (o.ship_date ? dayjs(o.ship_date).format("DD.MM.YYYY") : "—"),
          },
          { title: "Срок по плану", render: (_, o) => <PlanTag order={o} /> },
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
      <OrderDrawer
        order={opened}
        onClose={() => setOpenId(null)}
        onEdit={(o) => setEditing(o)}
        canManage={canManage}
        onAddTask={(kind, orderId) => setTaskCreate({ kind, orderId })}
        onSupply={(t) => setSupplyTarget({ id: t.id, name: t.name })}
      />
      <CreateTaskModal
        open={taskCreate?.kind === "film"}
        orderId={taskCreate?.orderId}
        onClose={() => setTaskCreate(null)}
        onCreated={(t, needsPf) => {
          if (t.production_order_id) setOpenId(t.production_order_id);
          if (needsPf) setSupplyTarget({ id: t.id, name: t.name ?? "" });
        }}
      />
      <OperationTaskModal open={taskCreate?.kind === "ops"} orderId={taskCreate?.orderId} onClose={() => setTaskCreate(null)} />
      {supplyTarget && (
        <PfSupplyModal
          taskId={supplyTarget.id}
          taskName={supplyTarget.name}
          canManage={canManage}
          onClose={() => setSupplyTarget(null)}
        />
      )}
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
  onAddTask,
  onSupply,
}: {
  order: ProductionOrder | null;
  onClose: () => void;
  onEdit: (o: ProductionOrder) => void;
  canManage: boolean;
  onAddTask: (kind: "film" | "ops", orderId: number) => void;
  onSupply: (t: OrderTask) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["production-orders"] });
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
    qc.invalidateQueries({ queryKey: ["pf-demand"] });
  };
  const [releasing, setReleasing] = useState(false);
  const [cardTask, setCardTask] = useState<number | null>(null);
  const rescheduleMutation = useMutation({
    mutationFn: (id: number) => rescheduleOrder(id),
    onSuccess: (o) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["plan-board"] });
      message.success(o.plan_finish ? `Сроки пересчитаны: готово к ${dayjs(o.plan_finish).format("DD.MM")}` : "Сроки пересчитаны");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось пересчитать сроки")),
  });
  const closeMutation = useMutation({
    mutationFn: (id: number) => closeProductionOrder(id),
    onSuccess: () => {
      invalidate();
      message.success("Заказ закрыт");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось закрыть заказ")),
  });
  const completeMutation = useMutation({
    mutationFn: (id: number) => completeProductionOrder(id),
    onSuccess: () => {
      invalidate();
      message.success("Заказ закрыт: всё сделано");
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
                <Button type="primary" onClick={() => setReleasing(true)}>
                  Запустить…
                </Button>
                
              </>
            )}
            {order.status === "released" && (
              <>
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "film", label: "Задание с плёнкой (окутка, ламинация)" },
                      { key: "ops", label: "Задание без плёнки (операции участка)" },
                    ],
                    onClick: ({ key }) => onAddTask(key as "film" | "ops", order.id),
                  }}
                >
                  <Button>+ Задание ▾</Button>
                </Dropdown>
                <Button loading={rescheduleMutation.isPending} onClick={() => rescheduleMutation.mutate(order.id)}>
                  Пересчитать сроки
                </Button>
                <Button onClick={() => navigate("/planner")}>Планировщик →</Button>
                <Popconfirm
                  title="Закрыть: всё сделано?"
                  description="Все строки будут отмечены сделанными полностью — без отчёта и без списания плёнки (она списывается метражом отдельно). Задания уйдут в архив."
                  okText="Закрыть"
                  cancelText="Отмена"
                  onConfirm={() => completeMutation.mutate(order.id)}
                >
                  <Button loading={completeMutation.isPending}>Закрыть: всё сделано</Button>
                </Popconfirm>
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
          <Space wrap>
            <Typography.Text type="secondary">
              {order.ship_date ? `Отгрузка ${dayjs(order.ship_date).format("DD.MM.YYYY")}. ` : ""}
              {order.note ?? ""}
            </Typography.Text>
            {order.status !== "draft" && <PlanTag order={order} />}
          </Space>
          {(order.tasks ?? []).length > 0 && (
            <Card size="small" title="Задания участкам">
              <Table<OrderTask>
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={order.tasks}
                scroll={{ x: "max-content" }}
                columns={[
                  {
                    title: "Задание",
                    render: (_, t) => (
                      <Space size={4} wrap>
                        <a onClick={() => setCardTask(t.id)}>
                          №{t.id} · {t.name}
                        </a>
                        {t.with_film && <Tag color="blue">плёнка</Tag>}
                        {t.for_task_id && <Tag color="geekblue">п/ф под №{t.for_task_id}</Tag>}
                        {!t.is_active && <Tag>в архиве</Tag>}
                      </Space>
                    ),
                  },
                  { title: "Участок", render: (_, t) => t.area_name ?? t.area },
                  {
                    title: "План",
                    render: (_, t) =>
                      t.plan_from
                        ? t.plan_from === t.plan_to
                          ? dayjs(t.plan_from).format("DD.MM")
                          : `${dayjs(t.plan_from).format("DD.MM")}–${dayjs(t.plan_to).format("DD.MM")}`
                        : "—",
                  },
                  {
                    title: "Сделано",
                    render: (_, t) => (
                      <Space size={8}>
                        <Progress percent={t.planned ? Math.round((t.done / t.planned) * 100) : 0} size="small" style={{ width: 100 }} />
                        <span>
                          {t.done} из {t.planned}
                        </span>
                      </Space>
                    ),
                  },
                  {
                    title: "",
                    render: (_, t) =>
                      canManage && t.is_active && t.with_parts ? (
                        <Button size="small" onClick={() => onSupply(t)}>
                          Обеспечение п/ф
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </Card>
          )}
          {order.status === "released" && canManage && <OrderReport order={order} />}
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
      {releasing && order && <ReleaseOrderModal order={order} onClose={() => setReleasing(false)} />}
      <TaskCardDrawer taskId={cardTask} onClose={() => setCardTask(null)} canManage={canManage} canReport={canManage} />
    </Drawer>
  );
}

/** Отчёт по заказу прямо из карточки — быстрый отчёт видом «таблица»,
 * только строки этого заказа, участок — из его открытых заданий. */
function OrderReport({ order }: { order: ProductionOrder }) {
  const areas = [...new Map((order.tasks ?? []).filter((t) => t.is_active).map((t) => [t.area, t.area_name ?? t.area])).entries()];
  const [area, setArea] = useState<string | null>(null);
  const current = area && areas.some(([code]) => code === area) ? area : areas[0]?.[0];
  if (!current) return null;
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {areas.length > 1 && (
        <Segmented value={current} onChange={(v) => setArea(v as string)} options={areas.map(([value, label]) => ({ value, label }))} />
      )}
      <FastReportPanel key={current} area={current} orderId={order.id} defaultView="table" title={`Отчёт по заказу · ${areas.find(([c]) => c === current)?.[1]}`} />
    </Space>
  );
}

/** Срок по плану: успевает к отгрузке / не успевает / просрочено / без плана. */
function PlanTag({ order }: { order: ProductionOrder }) {
  if (order.status === "draft") return <Typography.Text type="secondary">—</Typography.Text>;
  if (!order.planned) return <Tag>без плана</Tag>;
  const finish = order.plan_finish ? dayjs(order.plan_finish).format("DD.MM") : "";
  return (
    <Space size={4} wrap>
      {order.plan_late ? (
        <Tag color="red">не успевает: готово {finish}</Tag>
      ) : (
        <Tag color="green">успевает: готово {finish}</Tag>
      )}
      {(order.plan_overdue ?? 0) > 0 && <Tag color="orange">просрочено {order.plan_overdue} шт</Tag>}
    </Space>
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
  const [kind, setKind] = useState<OrderKind>(order?.kind ?? "customer");
  const [lines, setLines] = useState<LineDraft[]>(
    order ? order.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity, note: l.note ?? "" })) : [{ item_id: null, quantity: null, note: "" }],
  );
  const patch = (i: number, p: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  // Модель в заказ не идёт — по ней выбирается вариант (размер, цвет,
  // кромка): есть — берётся, нет — заводится сам (VariantPicker).
  const [picking, setPicking] = useState<{ line: number; model: Item } | null>(null);
  const items = itemsQuery.data ?? [];
  const itemOptions = [
    {
      label: "Модели — выбрать размер и цвет",
      options: items
        .filter((i) => i.is_model && i.type_id)
        .map((i) => ({ value: i.id, label: `${i.name} — выбрать вариант…` })),
    },
    {
      label: "Позиции",
      options: items
        .filter((i) => i.kind_code !== "plenka" && i.kind_code !== "material" && !i.is_model)
        .map((i) => ({ value: i.id, label: `${i.name} · ${i.kind_name}` })),
    },
  ];

  const mutation = useMutation({
    mutationFn: () => {
      const payload: OrderInput = {
        name: name.trim(),
        ship_date: shipDate ? shipDate.format("YYYY-MM-DD") : null,
        note: note.trim() || null,
        kind,
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
  const invalid =
    !name.trim() || !shipDate || lines.length === 0 || lines.some((l) => !l.item_id || !l.quantity || l.quantity <= 0);

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
          <Form.Item label="Для кого">
            <Segmented
              value={kind}
              onChange={(v) => setKind(v as OrderKind)}
              options={[
                { value: "customer", label: "Клиенту" },
                { value: "stock", label: "На склад" },
              ]}
            />
          </Form.Item>
          <Form.Item
            label={kind === "stock" ? "Готово к" : "Отгрузка"}
            required
            extra={kind === "stock" ? "Пополнение остатка — продажникам не показывается; от даты считаются сроки" : "От неё считаются сроки операций"}
          >
            <DatePicker format="DD.MM.YYYY" value={shipDate} onChange={setShipDate} />
          </Form.Item>
        </Space>
        <Form.Item label="Комментарий">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Form.Item>
        <Typography.Text strong>Позиции</Typography.Text>
        {items.length === 0 && !itemsQuery.isLoading ? (
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
                  onChange={(v) => {
                    const picked = items.find((x) => x.id === v);
                    if (picked?.is_model) setPicking({ line: i, model: picked });
                    else patch(i, { item_id: v });
                  }}
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
      {picking && (
        <VariantPicker
          modelId={picking.model.id}
          modelName={picking.model.name}
          typeId={picking.model.type_id as number}
          onClose={() => setPicking(null)}
          onPicked={(itemId) => {
            patch(picking.line, { item_id: itemId });
            setPicking(null);
          }}
        />
      )}
    </Modal>
  );
}
