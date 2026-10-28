import { useEffect, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Segmented,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import OrderDatesCard from "./OrderDatesCard";
import { OrderNeedsCard } from "./NeedsViews";
import { ReduceModal, useCancelOrder } from "./OrderControl";
import CreateTaskModal from "./CreateTaskModal";
import OperationTaskModal from "./OperationTaskModal";
import PfSupplyModal from "./PfSupplyModal";
import ReleaseWorkspace from "./ReleaseWorkspace";
import LaminationPrelaunchModal from "./LaminationPrelaunchModal";
import PrintTasksModal from "./PrintTasksModal";
import FastReportPanel from "./fastReport/FastReportPanel";
import TaskCardDrawer from "./TaskCardDrawer";
import OrderFlow from "./OrderFlow";
import { OrderHistory, OrderMaterials, OrderPlan } from "./OrderTabs";
import ItemLinesEditor, { emptyLine, type LineDraft } from "../../../components/ItemLinesEditor";
import { useAuth } from "../../../auth/AuthContext";
import { listAreas } from "../../../api/areas";
import { listOrderCategories, createOrderCategory,
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
  PRIORITY_COLOR,
  PRIORITY_LABEL,
} from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";
import { hasPerm } from "../../../auth/permissions";

const STATUS_COLOR: Record<OrderStatus, string> = { draft: "default", released: "blue", closed: "green" };

type ListFilter = "all" | "late" | "pf" | "stock" | "draft";
// Отборы списка заказов (30.09): что не успевает, что ждёт п/ф, на склад,
// черновики; участок — выбором (раньше — только «Фабрика»).
const LIST_FILTERS: [ListFilter, string, (o: ProductionOrder) => boolean][] = [
  ["all", "Все", () => true],
  ["late", "Не успевает", (o) => !!o.plan_late],
  ["pf", "Ждёт п/ф", (o) => (o.tasks ?? []).some((t) => t.for_task_id != null && t.is_active && t.done < t.planned)],
  ["stock", "На склад", (o) => o.kind === "stock"],
  ["draft", "Черновики", (o) => o.status === "draft"],
];

function ShipCell({ order: o }: { order: ProductionOrder }) {
  const window = o.ship_from || o.ship_to ? `${o.ship_from ? dayjs(o.ship_from).format("DD.MM") : "…"}–${o.ship_to ? dayjs(o.ship_to).format("DD.MM") : "…"}` : null;
  const req =
    o.request_status === "submitted" ? <Tag color="gold">заявка ждёт</Tag> : o.request_status === "returned" ? <Tag color="red">возвращена</Tag> : null;
  return (
    <Space direction="vertical" size={0}>
      <span>
        {o.ship_date && o.request_status !== "submitted" ? dayjs(o.ship_date).format("DD.MM.YYYY") : "—"} {req}
      </span>
      {window && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          вилка {window}
        </Typography.Text>
      )}
    </Space>
  );
}

// Заказ с позициями — готовность по последней операции позиций; заказ
// из заданий (окутка из наряда, операции участка, п/ф) — по строкам заданий.
export const orderTotals = (o: ProductionOrder) => {
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
/** Заказы на производство (цех: задания, запуск, отчёт). «Готовность к
 * отгрузке» — один экран «Продажи и заказы → Готовность заказов» (05.10:
 * была ещё и вкладкой здесь — дубль); старый адрес ?view=readiness и вход
 * без прав цеха ведут туда. */
export default function ProductionOrders() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const shop =
    !!user?.is_superuser || ["production_tasks.manage", "production_tasks.view", "production_tasks.report"].some((c) => user?.permissions.includes(c));
  if (!shop || params.get("view") === "readiness") return <Navigate to="/order-readiness" replace />;
  return <OrdersList />;
}

function OrdersList() {
  const { user } = useAuth();
  const canManage = hasPerm(user, "production_tasks.manage");
  const [includeClosed, setIncludeClosed] = useState(false);
  // ?order=ID (сквозной поиск по номеру) — сразу открыть страницу заказа.
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const openOrder = (id: number) => navigate(`/production-orders/${id}`);
  useEffect(() => {
    const id = Number(params.get("order"));
    if (id) navigate(`/production-orders/${id}`, { replace: true });
  }, [params, navigate]);
  const [editing, setEditing] = useState<ProductionOrder | "new" | null>(null);
  const [taskCreate, setTaskCreate] = useState<TaskCreate | null>(null);
  const [supplyTarget, setSupplyTarget] = useState<{ id: number; name: string } | null>(null);
  const [includeClosedDefault] = useState(!!params.get("order"));
  const ordersQuery = useQuery({
    queryKey: ["production-orders", includeClosed || includeClosedDefault],
    queryFn: () => listProductionOrders(includeClosed || includeClosedDefault),
  });
  const [listFilter, setListFilter] = useState<ListFilter>("all");
  const [areaFilter, setAreaFilter] = useState<string | null>(null);
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const [q, setQ] = useState("");
  const allOrders = ordersQuery.data ?? [];
  const needle = q.trim().toLowerCase();
  const shownOrders = allOrders
    .filter(LIST_FILTERS.find((f) => f[0] === listFilter)![2])
    .filter((o) => !areaFilter || (o.tasks ?? []).some((t) => t.area === areaFilter))
    .filter(
      (o) =>
        !needle ||
        `${o.id} ${o.name} ${o.lines.map((l) => `${l.item_name} ${l.invoice_no ?? ""}`).join(" ")} ${(o.tasks ?? []).map((t) => t.name).join(" ")}`
          .toLowerCase()
          .includes(needle),
    );

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
                  // три входа вместо пяти (28.10): для покупателя — только через его
                  // заказ (счёт, график, сделка — там); внутренний — без клиента;
                  // задание участку — в «Заданиях цеха»
                  items: [
                    { key: "customer", label: "Для покупателя — принять и собрать из его заказа →" },
                    { key: "items", label: "Внутренний заказ — на склад или п/ф, из позиций номенклатуры…" },
                    { type: "divider" },
                    { key: "task", label: "Задание участку (окутка, ламинация, работы) — в «Заданиях цеха» →" },
                  ],
                  onClick: ({ key }) => {
                    if (key === "customer") navigate("/customer-orders?section=intake");
                    else if (key === "items") setEditing("new");
                    else navigate("/production-tasks?tab=tasks&new=1");
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
          Заказы покупателей (счета 1С) принимаются на вкладке «Приём в производство» и собираются в запуск — сразу при приёме или позже из «Заказов покупателей».
          Вся работа цеху заводится здесь. Новый заказ (вручную или из графика) — черновик: на его странице видно, что
          получит каждый участок; там же выбираются п/ф со склада, площадки ламинации и сроки — настройка сохраняется,
          к ней можно вернуться. «Запустить заказ» создаёт задания участкам, их выполняют в «Заданиях цеха». Окутка из
          наряда или плана заготовок и работы без плёнки — сразу заказ с заданием.
        </Typography.Paragraph>
      </Card>
      <Space wrap size={[6, 6]}>
        <Input.Search allowClear placeholder="№, название, позиция, задание" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
        {LIST_FILTERS.map(([k, label, fn]) => (
          <Tag.CheckableTag key={k} checked={listFilter === k} onChange={() => setListFilter(k)} style={{ fontSize: 13, padding: "3px 10px" }}>
            {label} {allOrders.filter(fn).length}
          </Tag.CheckableTag>
        ))}
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Участок"
          style={{ width: 240 }}
          value={areaFilter ?? undefined}
          onChange={(v) => setAreaFilter(v ?? null)}
          options={(areasQuery.data ?? [])
            .filter((a) => a.is_active && allOrders.some((o) => (o.tasks ?? []).some((t) => t.area === a.code)))
            .map((a) => ({
              value: a.code,
              label: `${a.name} (${allOrders.filter((o) => (o.tasks ?? []).some((t) => t.area === a.code)).length})`,
            }))}
        />
      </Space>
      <ResponsiveTable<ProductionOrder>
        tableKey="production-orders"
        lockedColumns={["Заказ"]}
        size="small"
        rowKey="id"
        loading={ordersQuery.isLoading}
        dataSource={shownOrders}
        pagination={{ pageSize: 30 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Заказов пока нет" }}
        onRow={(o) => ({ onClick: () => openOrder(o.id), style: { cursor: "pointer" } })}
        columns={[
          {
            title: "Заказ",
            render: (_, o) => (
              <Space direction="vertical" size={0}>
                <span>
                  №{o.id} «{o.name}» {o.kind === "stock" && <Tag color="green">на склад</Tag>}
                  {(o.priority ?? 0) > 0 && <Tag color={PRIORITY_COLOR[o.priority ?? 0]}>{PRIORITY_LABEL[o.priority ?? 0]}</Tag>}
                  {o.customer && <Typography.Text type="secondary"> · {o.customer}</Typography.Text>}
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
          {
            title: "Из счетов",
            render: (_, o) =>
              o.customer_orders?.length ? (
                <Space size={[4, 0]} wrap style={{ maxWidth: 220 }}>
                  {o.customer_orders.map((c) => (
                    <Link key={c.id} to={`/customer-orders/${c.id}`} onClick={(e) => e.stopPropagation()} title={c.customer ?? undefined}>
                      {c.invoice_no}
                    </Link>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">{o.kind === "stock" ? "на склад" : "без заказа клиента"}</Typography.Text>
              ),
          },
          { title: "Статус", render: (_, o) => <Tag color={STATUS_COLOR[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Tag> },
          {
            title: "Отгрузка / готово к",
            render: (_, o) => <ShipCell order={o} />,
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
      <CreateTaskModal
        open={taskCreate?.kind === "film"}
        orderId={taskCreate?.orderId}
        onClose={() => setTaskCreate(null)}
        onCreated={(t, needsPf) => {
          if (t.production_order_id) openOrder(t.production_order_id);
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
      {editing && (
        <OrderModal
          order={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(o) => {
            setEditing(null);
            openOrder(o.id);
          }}
        />
      )}
    </Space>
  );
}

/** Заказ на производство — страница (05.10, вместо боковой панели).
 * Черновик — рабочее место запуска (ReleaseWorkspace): всё, что решается
 * перед запуском, в одном месте и сохраняется в черновике. Запущенный —
 * ход, отчёт, материалы, план, история. */
export function OrderView({
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
    qc.invalidateQueries({ queryKey: ["production-order"] });
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
    qc.invalidateQueries({ queryKey: ["pf-demand"] });
  };
  const [printing, setPrinting] = useState(false);
  const [cardTask, setCardTask] = useState<number | null>(null);
  const [lamOpen, setLamOpen] = useState(false);
  const [reduceOpen, setReduceOpen] = useState(false);
  const cancelOrder = useCancelOrder(order);
  const [orderTab, setOrderTab] = useState("flow");
  // Открыли другой заказ — с вкладки «Ход».
  const [tabFor, setTabFor] = useState<number | null>(order?.id ?? null);
  if ((order?.id ?? null) !== tabFor) {
    setTabFor(order?.id ?? null);
    setOrderTab("flow");
  }
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
    <Card
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
                <Button onClick={() => onEdit(order)}>Изменить строки</Button>
                <Button onClick={() => setLamOpen(true)}>Окутка панелей отдельно…</Button>
                <Popconfirm title="Удалить черновик?" okText="Удалить" cancelText="Отмена" onConfirm={() => deleteMutation.mutate(order.id)}>
                  <Button danger>Удалить черновик</Button>
                </Popconfirm>
              </>
            )}
            {(order.tasks ?? []).length > 0 && (
              <Button onClick={() => setPrinting(true)}>Печать заданий…</Button>
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
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "reschedule", label: "Пересчитать сроки" },
                      { key: "planner", label: "Открыть в планировщике →" },
                      { type: "divider" },
                      { key: "reduce", label: "Уменьшить количество…" },
                      { key: "cancel", label: "Отменить заказ…", danger: true },
                      { type: "divider" },
                      { key: "complete", label: "Закрыть: всё сделано" },
                      { key: "close", label: "Закрыть заказ" },
                    ],
                    onClick: ({ key }) => {
                      if (key === "reschedule") rescheduleMutation.mutate(order.id);
                      else if (key === "planner") navigate("/planner");
                      else if (key === "reduce") setReduceOpen(true);
                      else if (key === "cancel") cancelOrder();
                      else if (key === "complete")
                        Modal.confirm({
                          title: "Закрыть: всё сделано?",
                          content:
                            "Все строки будут отмечены сделанными полностью — без отчёта и без списания плёнки (она списывается метражом отдельно). Задания уйдут в архив.",
                          okText: "Закрыть",
                          cancelText: "Отмена",
                          onOk: () => completeMutation.mutateAsync(order.id),
                        });
                      else if (key === "close")
                        Modal.confirm({
                          title: "Закрыть заказ?",
                          content: "Задания заказа уйдут в архив.",
                          okText: "Закрыть",
                          cancelText: "Отмена",
                          onOk: () => closeMutation.mutateAsync(order.id),
                        });
                    },
                  }}
                >
                  <Button loading={rescheduleMutation.isPending || completeMutation.isPending || closeMutation.isPending}>Ещё ▾</Button>
                </Dropdown>
              </>
            )}
          </Space>
        )
      }
    >
      {/* комментарий заказа (13.10) — виден сразу и печатается в шапке каждого задания */}
      {order?.note && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={<span>Комментарий к заказу: <b>{order.note}</b></span>} />}
      {order && order.status === "draft" ? (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {(order.tasks ?? []).length > 0 && (
            <Alert
              type="info"
              showIcon
              message="Окутка панелей запущена отдельно — при запуске заказа она не повторится"
              description={
                <Space wrap>
                  {(order.tasks ?? []).map((t) => (
                    <Button key={t.id} size="small" type="link" style={{ padding: 0 }} onClick={() => setCardTask(t.id)}>
                      №{t.id} {t.area_name ?? t.area}: {t.planned} шт{t.done ? `, сделано ${t.done}` : ""}
                    </Button>
                  ))}
                </Space>
              }
            />
          )}
          {order.kind !== "stock" && (order.ship_date || order.promised_ready) && (
            <OrderDatesCard order={order} canManage={canManage} totalQty={orderTotals(order).qty} />
          )}
          {(order.ship_date || order.promised_ready) && <OrderNeedsCard orderId={order.id} />}
          {canManage ? (
            <ReleaseWorkspace order={order} canManage={canManage} onEditLines={() => onEdit(order)} />
          ) : (
            <Card size="small" title={`Позиции — ${order.lines.length}, ${order.lines.reduce((s, l) => s + l.quantity, 0)} шт`}>
              <ResponsiveTable
                tableKey="request-lines"
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={order.lines}
                columns={[
                  { title: "Позиция", dataIndex: "item_name" },
                  { title: "Кол-во", dataIndex: "quantity", align: "right" },
                  { title: "Счёт", dataIndex: "invoice_no", render: (v: string | null) => v ?? "—" },
                  { title: "Примечание", dataIndex: "note", render: (v: string | null) => v ?? "" },
                ]}
              />
            </Card>
          )}
        </Space>
      ) : order && (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {/* заказ без строк (окутка из наряда, заготовки) — сразу задание; даты — если заданы, потребность — под заданием */}
        {order.kind !== "stock" && (order.lines.length > 0 || order.ship_date || order.promised_ready) && (
          <OrderDatesCard order={order} canManage={canManage} totalQty={orderTotals(order).qty} />
        )}
        {order.status === "released" && order.lines.length > 0 && <OrderNeedsCard orderId={order.id} />}
        <Tabs
          activeKey={orderTab}
          onChange={setOrderTab}
          items={[
            {
              key: "flow",
              label: "Ход",
              children: (
                <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Space wrap>
            <Typography.Text type="secondary">
              {order.ship_date ? `Отгрузка ${dayjs(order.ship_date).format("DD.MM.YYYY")}. ` : ""}
              {order.note ?? ""}
            </Typography.Text>
            {order.status !== "draft" && <PlanTag order={order} />}
          </Space>
          <OrderFlow order={order} canManage={canManage} onOpenTask={setCardTask} onSupply={onSupply} />
                </Space>
              ),
            },
            ...(order.status === "released" && canManage ? [{ key: "report", label: "Отчёт", children: <OrderReport order={order} /> }] : []),
            ...(order.status !== "draft"
              ? [
                  { key: "materials", label: "Материалы", children: <OrderMaterials order={order} onOpenTask={setCardTask} /> },
                  { key: "plan", label: "План", children: <OrderPlan order={order} /> },
                ]
              : []),
            { key: "history", label: "История", children: <OrderHistory order={order} /> },
          ]}
        />
        {order.status === "released" && order.lines.length === 0 && <OrderNeedsCard orderId={order.id} />}
        </Space>
      )}
      {printing && order && (
        <PrintTasksModal
          tasks={(order.tasks ?? []).filter((t) => t.is_active)}
          title={`Задания по заказу №${order.id} «${order.name}»`}
          onClose={() => setPrinting(false)}
        />
      )}
      {lamOpen && order && <LaminationPrelaunchModal order={order} onClose={() => setLamOpen(false)} />}
      {reduceOpen && order && <ReduceModal order={order} onClose={() => setReduceOpen(false)} />}
      <TaskCardDrawer taskId={cardTask} onClose={() => setCardTask(null)} canManage={canManage} canReport={canManage} />
    </Card>
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


export function OrderModal({
  order,
  onClose,
  onSaved,
}: {
  order: ProductionOrder | null;
  onClose: () => void;
  onSaved: (o: ProductionOrder) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(order?.name ?? "");
  const [shipDate, setShipDate] = useState<Dayjs | null>(order?.ship_date ? dayjs(order.ship_date) : null);
  // Вилка отгрузки менеджера (09.10); твёрдую дату ставит производство.
  const { user: me } = useAuth();
  const isManager = hasPerm(me, "production_tasks.manage");
  const [shipWindow, setShipWindow] = useState<[Dayjs | null, Dayjs | null]>([
    order?.ship_from ? dayjs(order.ship_from) : null,
    order?.ship_to ? dayjs(order.ship_to) : null,
  ]);
  const [note, setNote] = useState(order?.note ?? "");
  const [customer, setCustomer] = useState(order?.customer ?? "");
  const [amount, setAmount] = useState<number | null>(order?.amount_rub ?? null);
  const [priority, setPriority] = useState<number>(order?.priority ?? 0);
  const [promisedReady, setPromisedReady] = useState<Dayjs | null>(order?.promised_ready ? dayjs(order.promised_ready) : null);
  const [kind, setKind] = useState<OrderKind>(order?.kind ?? "customer");
  const [categoryId, setCategoryId] = useState<number | undefined>(order?.category_id ?? undefined);
  const categoriesQuery = useQuery({ queryKey: ["order-categories"], queryFn: listOrderCategories });
  const [newCategory, setNewCategory] = useState("");
  const addCategory = useMutation({
    mutationFn: (n: string) => createOrderCategory(n),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["order-categories"] });
      setCategoryId(c.id);
      setNewCategory("");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить категорию")),
  });
  const [lines, setLines] = useState<LineDraft[]>(
    order
      ? order.lines.map((l) => ({
          item_id: l.item_id, quantity: l.quantity, note: l.note ?? "", invoice_no: l.invoice_no ?? "",
          options: l.options ?? null, source_text: l.source_text ?? null, customer_order_line_id: l.customer_order_line_id ?? null,
        }))
      : [emptyLine()],
  );
  const initialKind: "izdelie" | "other" =
    (order?.lines ?? []).length > 0 && (order?.lines ?? []).every((l) => l.kind_name !== "Изделие") ? "other" : "izdelie";

  const mutation = useMutation({
    mutationFn: () => {
      const payload: OrderInput = {
        name: name.trim(),
        ship_date: shipDate ? shipDate.format("YYYY-MM-DD") : null,
        ship_from: shipWindow[0] ? shipWindow[0].format("YYYY-MM-DD") : null,
        ship_to: shipWindow[1] ? shipWindow[1].format("YYYY-MM-DD") : null,
        customer: customer.trim() || null,
        amount_rub: amount,
        priority,
        promised_ready: promisedReady ? promisedReady.format("YYYY-MM-DD") : null,
        note: note.trim() || null,
        kind,
        category_id: categoryId ?? null,
        lines: lines.map((l) => ({
          item_id: l.item_id as number,
          quantity: l.quantity as number,
          note: l.note.trim() || null,
          invoice_no: l.invoice_no.trim() || null,
          options: l.options ?? null,
          source_text: l.source_text ?? null,
          customer_order_line_id: l.customer_order_line_id ?? null,
        })),
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
    !name.trim() || (isManager ? !shipDate && !shipWindow[1] : !shipWindow[1]) || lines.length === 0 || lines.some((l) => !l.item_id || !l.quantity || l.quantity <= 0);

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
          {isManager && (
            <Form.Item
              label={kind === "stock" ? "Готово к" : "Отгрузка (100%)"}
              required={!shipWindow[1]}
              extra={kind === "stock" ? "Пополнение остатка — продажникам не показывается; от даты считаются сроки" : "От неё считаются сроки операций"}
            >
              <DatePicker format="DD.MM.YYYY" value={shipDate} onChange={setShipDate} />
            </Form.Item>
          )}
          {kind === "customer" && (
            <Form.Item label="Вилка отгрузки" required={!isManager} extra="Когда клиент готов забрать: с — по">
              <DatePicker.RangePicker
                format="DD.MM.YYYY"
                allowEmpty={[true, false]}
                value={shipWindow}
                onChange={(v) => setShipWindow([v?.[0] ?? null, v?.[1] ?? null])}
              />
            </Form.Item>
          )}
          {isManager && kind === "customer" && (
            <Form.Item label="Готовность (обещанная)" extra="Всё на складе ГП; от неё сроки этапов">
              <DatePicker format="DD.MM.YYYY" value={promisedReady} onChange={setPromisedReady} />
            </Form.Item>
          )}
        </Space>
        {kind === "customer" && (
          <Space size={12} style={{ display: "flex" }} wrap>
            <Form.Item label="Клиент" style={{ width: 300 }}>
              <Input value={customer} placeholder="Как в счёте 1С" onChange={(e) => setCustomer(e.target.value)} />
            </Form.Item>
            <Form.Item label="Сумма счёта, ₽">
              <InputNumber min={0} style={{ width: 160 }} value={amount} onChange={(v) => setAmount(v ?? null)} />
            </Form.Item>
            <Form.Item label="Приоритет">
              <Segmented
                value={priority}
                onChange={(v) => setPriority(v as number)}
                options={[
                  { value: 0, label: "Обычный" },
                  { value: 1, label: "Высокий" },
                  { value: 2, label: "Срочный" },
                ]}
              />
            </Form.Item>
          </Space>
        )}
        <Form.Item label="Категория" extra="Для аналитики; список пополняется прямо здесь">
          <Select
            allowClear
            style={{ width: 360 }}
            placeholder="Без категории"
            value={categoryId}
            onChange={(v) => setCategoryId(v)}
            options={(categoriesQuery.data ?? []).filter((c) => c.is_active || c.id === categoryId).map((c) => ({ value: c.id, label: c.name }))}
            popupRender={(menu) => (
              <>
                {menu}
                <Space style={{ padding: 8 }}>
                  <Input
                    size="small"
                    placeholder="Новая категория"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <Button size="small" disabled={!newCategory.trim()} loading={addCategory.isPending} onClick={() => addCategory.mutate(newCategory.trim())}>
                    Добавить
                  </Button>
                </Space>
              </>
            )}
          />
        </Form.Item>
        <Form.Item label="Комментарий" extra="Печатается в шапке каждого задания и в Excel">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Form.Item>
        <ItemLinesEditor lines={lines} onChange={setLines} withInvoice initialKind={initialKind} />
      </Form>
    </Modal>
  );
}
