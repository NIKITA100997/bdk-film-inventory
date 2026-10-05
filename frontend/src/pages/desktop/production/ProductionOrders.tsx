import { useState } from "react";
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
  Tabs,
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
import PrintTasksModal from "./PrintTasksModal";
import { ItemChars } from "../../../components/ItemChars";
import FastReportPanel from "./fastReport/FastReportPanel";
import OrderReadiness from "../OrderReadiness";
import TaskCardDrawer from "./TaskCardDrawer";
import { OrderHistory, OrderMaterials, OrderPlan } from "./OrderTabs";
import VariantPicker from "../../../components/VariantPicker";
import { useAuth } from "../../../auth/AuthContext";
import { listAreas } from "../../../api/areas";
import { listItems, type Item } from "../../../api/items";
import { listItemTypes } from "../../../api/itemTypes";
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
} from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";

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
/** Заказы на производство — два вида одного списка: «Заказы» (цех: задания,
 * запуск, отчёт) и «Готовность» (для продаж: когда будет готово, успевает
 * ли к отгрузке). Без прав цеха — только «Готовность». */
export default function ProductionOrders() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const shop =
    !!user?.is_superuser || ["production_tasks.manage", "production_tasks.view", "production_tasks.report"].some((c) => user?.permissions.includes(c));
  const view = !shop || params.get("view") === "readiness" ? "readiness" : "list";
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {shop && (
        <Segmented
          value={view}
          onChange={(v) => setParams(v === "readiness" ? { view: "readiness" } : {}, { replace: true })}
          options={[
            { value: "list", label: "Заказы" },
            { value: "readiness", label: "Готовность к отгрузке" },
          ]}
        />
      )}
      {view === "readiness" ? <OrderReadiness /> : <OrdersList />}
    </Space>
  );
}

function OrdersList() {
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
  const [printing, setPrinting] = useState(false);
  const [cardTask, setCardTask] = useState<number | null>(null);
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
            {order.status !== "draft" && (order.tasks ?? []).length > 0 && (
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
                      { key: "complete", label: "Закрыть: всё сделано" },
                      { key: "close", label: "Закрыть заказ" },
                    ],
                    onClick: ({ key }) => {
                      if (key === "reschedule") rescheduleMutation.mutate(order.id);
                      else if (key === "planner") navigate("/planner");
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
      {order && (
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
          {order.lines.map((l) => (
            <Card
              key={l.id}
              size="small"
              title={
                <Space wrap align="start">
                  <ItemChars chars={l.item_chars} name={l.item_name} strong={false} />
                  <Tag>{l.kind_name}</Tag>
                  {l.invoice_no && <Tag color="purple">счёт {l.invoice_no}</Tag>}
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
      )}
      {releasing && order && <ReleaseOrderModal order={order} onClose={() => setReleasing(false)} />}
      {printing && order && (
        <PrintTasksModal
          tasks={(order.tasks ?? []).filter((t) => t.is_active)}
          title={`Задания по заказу №${order.id} «${order.name}»`}
          onClose={() => setPrinting(false)}
        />
      )}
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

type LineDraft = { item_id: number | null; quantity: number | null; note: string; invoice_no: string };

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
      ? order.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity, note: l.note ?? "", invoice_no: l.invoice_no ?? "" }))
      : [{ item_id: null, quantity: null, note: "", invoice_no: "" }],
  );
  const patch = (i: number, p: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  // Модель в заказ не идёт — по ней выбирается вариант (размер, цвет,
  // кромка): есть — берётся, нет — заводится сам (VariantPicker).
  const [picking, setPicking] = useState<{ line: number; model: Item } | null>(null);
  const items = itemsQuery.data ?? [];
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const typeName = (id: number | null | undefined) => (id ? typesQuery.data?.find((t) => t.id === id)?.name : undefined);
  // Двери и п/ф в одном заказе почти не встречаются — список делится:
  // изделия по моделям (модель → её варианты), п/ф и прочее по типу.
  const orderable = items.filter((i) => i.kind_code !== "plenka" && i.kind_code !== "material");
  const isProduct = (i: Item) => i.kind_code === "izdelie";
  const [pickKind, setPickKind] = useState<"izdelie" | "other">(() => {
    const ls = order?.lines ?? [];
    return ls.length > 0 && ls.every((l) => l.kind_name !== "Изделие") ? "other" : "izdelie";
  });
  const groupBy = (list: Item[], key: (i: Item) => string) => {
    const m = new Map<string, Item[]>();
    for (const i of list) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"));
  };
  const modelName = (id: number | null) => items.find((m) => m.id === id)?.name;
  const itemOptions =
    pickKind === "izdelie"
      ? [
          {
            label: "Модели — выбрать размер и цвет",
            options: orderable
              .filter((i) => isProduct(i) && i.is_model && i.type_id)
              .map((i) => ({ value: i.id, label: `${i.name} — выбрать вариант…` })),
          },
          ...groupBy(
            orderable.filter((i) => isProduct(i) && !i.is_model),
            (i) => modelName(i.model_id) ?? typeName(i.type_id) ?? "Без модели",
          ).map(([label, list]) => ({ label, options: list.map((i) => ({ value: i.id, label: i.name })) })),
        ]
      : [
          {
            label: "Модели — выбрать вариант",
            options: orderable
              .filter((i) => !isProduct(i) && i.is_model && i.type_id)
              .map((i) => ({ value: i.id, label: `${i.name} — выбрать вариант…` })),
          },
          ...groupBy(
            orderable.filter((i) => !isProduct(i) && !i.is_model),
            (i) => typeName(i.type_id) ?? i.kind_name,
          ).map(([label, list]) => ({ label, options: list.map((i) => ({ value: i.id, label: i.name })) })),
        ].filter((g) => g.options.length > 0);
  // Уже выбранная позиция из другой половины списка — показываем подписью.
  const optionsFor = (itemId: number | null) => {
    const it = itemId != null ? items.find((x) => x.id === itemId) : undefined;
    if (!it || itemOptions.some((g) => g.options.some((o) => o.value === it.id))) return itemOptions;
    return [{ label: "Выбрано", options: [{ value: it.id, label: it.name }] }, ...itemOptions];
  };

  const mutation = useMutation({
    mutationFn: () => {
      const payload: OrderInput = {
        name: name.trim(),
        ship_date: shipDate ? shipDate.format("YYYY-MM-DD") : null,
        note: note.trim() || null,
        kind,
        category_id: categoryId ?? null,
        lines: lines.map((l) => ({
          item_id: l.item_id as number,
          quantity: l.quantity as number,
          note: l.note.trim() || null,
          invoice_no: l.invoice_no.trim() || null,
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
        <Form.Item label="Комментарий">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Form.Item>
        <Space wrap>
          <Typography.Text strong>Позиции</Typography.Text>
          <Segmented
            size="small"
            value={pickKind}
            onChange={(v) => setPickKind(v as "izdelie" | "other")}
            options={[
              { value: "izdelie", label: "Изделия" },
              { value: "other", label: "П/ф и прочее" },
            ]}
          />
        </Space>
        {items.length === 0 && !itemsQuery.isLoading ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет позиций" />
        ) : (
          <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
            {lines.map((l, i) => (
              <Space key={i} wrap>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder={pickKind === "izdelie" ? "Изделие: модель или готовый вариант" : "П/ф или прочая позиция"}
                  style={{ width: 360 }}
                  loading={itemsQuery.isLoading}
                  value={l.item_id ?? undefined}
                  options={optionsFor(l.item_id)}
                  onChange={(v) => {
                    const picked = items.find((x) => x.id === v);
                    if (picked?.is_model) setPicking({ line: i, model: picked });
                    else patch(i, { item_id: v });
                  }}
                />
                <InputNumber min={1} placeholder="шт" style={{ width: 80 }} value={l.quantity} onChange={(v) => patch(i, { quantity: v })} />
                <Input placeholder="счёт 1С" style={{ width: 110 }} value={l.invoice_no} onChange={(e) => patch(i, { invoice_no: e.target.value })} />
                <Input placeholder="примечание" style={{ width: 140 }} value={l.note} onChange={(e) => patch(i, { note: e.target.value })} />
                {lines.length > 1 && (
                  <Button size="small" danger onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    Убрать
                  </Button>
                )}
              </Space>
            ))}
            <Button onClick={() => setLines((ls) => [...ls, { item_id: null, quantity: null, note: "", invoice_no: "" }])}>+ позиция</Button>
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
