import type { ReactNode } from "react";
import { Button, Space } from "antd";
import { useNavigate } from "react-router-dom";
import type { CurrentUser as User } from "../../auth/types";
import { hasPerm } from "../../auth/permissions";
import { lazyPage } from "../../utils/lazyPage";
import { InboxList, useInbox } from "../../components/InboxList";
import { SearchBox } from "../desktop/Overview";

const Overview = lazyPage(() => import("../desktop/Overview"));
const DailyPlanTab = lazyPage(() => import("../desktop/production/DailyPlanTab"));
const FilmIssueBoard = lazyPage(() => import("../desktop/FilmIssueBoard"));
const AreaRequestsPanel = lazyPage(() => import("../../components/areaSupply/AreaRequestsPanel"));
const TransfersInTransit = lazyPage(() => import("../desktop/WarehouseTransfers").then((m) => ({ default: m.InTransitTab })));
const IntakeTab = lazyPage(() => import("../desktop/customerOrders/IntakeTab"));
const ShortagesTab = lazyPage(() => import("../desktop/production/NeedsViews").then((m) => ({ default: m.ShortagesTab })));
const MaterialsDemand = lazyPage(() => import("../desktop/production/Demand").then((m) => ({ default: m.MaterialsDemand })));
const ReorderTab = lazyPage(() => import("../desktop/Reports").then((m) => ({ default: m.ReorderTab })));
const OrderDeadlines = lazyPage(() => import("../desktop/production/OrderDeadlines"));
const AreaLoadWidget = lazyPage(() => import("./homeWidgets").then((m) => ({ default: m.AreaLoadWidget })));
const OverdueWidget = lazyPage(() => import("./homeWidgets").then((m) => ({ default: m.OverdueWidget })));
const DeliveriesWidget = lazyPage(() => import("./homeWidgets").then((m) => ({ default: m.DeliveriesWidget })));
const MyOrdersWidget = lazyPage(() => import("./homeWidgets").then((m) => ({ default: m.MyOrdersWidget })));
const TransfersHub = lazyPage(() => import("../desktop/WarehouseTransfers").then((m) => ({ default: m.HubTab })));

/** Модуль «Общего» (28.10): не сводка, а место работы — встроенная рабочая
 * панель или кнопки действий. Доступен — по правам; «по умолчанию» —
 * стандартный набор этого сотрудника, если он свой не настроил. */
export interface HomeModule {
  key: string;
  title: string;
  hint: string;
  /** во всю ширину (рабочие панели) или в колонку (кнопки, короткие списки) */
  wide: boolean;
  /** «Открыть полностью» — экран, где этот модуль живёт */
  link?: string;
  available: (u: User) => boolean;
  /** цветная метка заголовка (28.10): работа — оранжевая (по умолчанию), действия — зелёная, сведения — тёмная */
  accent?: "green" | "navy" | "blue" | "red";
  render: () => ReactNode;
}

const isMaster = (u: User) =>
  !u.is_superuser && !!u.area && hasPerm(u, "production_tasks.report") && !hasPerm(u, "production_tasks.all_areas");
const isWarehouse = (u: User) => !u.is_superuser && hasPerm(u, "units.issue", "units.receive");

function InboxModule() {
  const q = useInbox();
  return <InboxList items={q.data ?? []} />;
}

const QUICK: { label: string; path: string; perms: string[] }[] = [
  { label: "Приёмка плёнки", path: "/m/receive", perms: ["units.receive"] },
  { label: "Приёмка материалов", path: "/m/receive?kind=material", perms: ["units.receive", "materials.manage"] },
  { label: "Приёмка п/ф", path: "/m/receive?kind=pf", perms: ["part_units.manage"] },
  { label: "Выдача плёнки", path: "/m/issue", perms: ["units.issue"] },
  { label: "Выдача п/ф", path: "/m/issue?kind=pf", perms: ["units.issue", "part_units.manage"] },
  { label: "Перемещение между складами", path: "/warehouse-transfers", perms: ["warehouse_transfers.manage"] },
  { label: "Инвентаризация", path: "/inventory", perms: ["inventory.manage", "part_units.count", "fg.ship"] },
  { label: "Заявка на склад", path: "/production-tasks?tab=film-issue&sub=requests", perms: ["production_tasks.report"] },
  { label: "Новое задание участку", path: "/production-tasks?tab=tasks&new=1", perms: ["production_tasks.manage"] },
  { label: "Приём в производство", path: "/customer-orders?section=intake", perms: ["production_tasks.manage"] },
  { label: "Новый заказ покупателя", path: "/customer-orders", perms: ["orders.request", "production_tasks.manage"] },
  { label: "Заявки и заказы поставщикам", path: "/purchasing", perms: ["purchasing.manage"] },
  { label: "Остатки", path: "/stock", perms: [] },
];

function QuickActions({ user }: { user: User }) {
  const navigate = useNavigate();
  const items = QUICK.filter((q) => !q.perms.length || hasPerm(user, ...q.perms));
  return (
    <Space wrap>
      {items.map((q) => (
        <Button key={q.path} size="large" onClick={() => navigate(q.path)}>
          {q.label}
        </Button>
      ))}
    </Space>
  );
}

export const MODULES: HomeModule[] = [
  {
    key: "inbox", title: "Ждёт меня", hint: "что ждёт вашего действия — сразу в нужное место", wide: false,
    available: () => true, render: () => <InboxModule />,
  },
  {
    key: "quick", title: "Быстрые действия", hint: "кнопки ваших ежедневных операций", wide: false, accent: "green",
    available: () => true, render: () => null, // подставляется с пользователем, см. renderModule
  },
  {
    key: "search", title: "Найти", hint: "рулон, партия, задание, заказ — по номеру или скану", wide: false, accent: "navy",
    available: () => true, render: () => <SearchBox />,
  },
  {
    key: "my-area", title: "Мой участок", hint: "задания на сегодня и быстрый отчёт", wide: true, link: "/production-tasks",
    available: (u) => hasPerm(u, "production_tasks.report", "production_tasks.manage"), render: () => <DailyPlanTab />,
  },
  {
    key: "area-requests", title: "Заявки участков на склад", hint: "подать заявку или выдать по ней", wide: true,
    link: "/production-tasks?tab=film-issue&sub=requests",
    available: (u) => hasPerm(u, "production_tasks.report", "production_tasks.manage", "units.issue"), render: () => <AreaRequestsPanel />,
  },
  {
    key: "film-issue", title: "Выдача плёнки участкам", hint: "что резать и выдавать под задания", wide: true,
    link: "/production-tasks?tab=film-issue",
    available: (u) => hasPerm(u, "units.issue", "production_tasks.manage", "production_tasks.view"), render: () => <FilmIssueBoard />,
  },
  {
    key: "transfers-in", title: "Перемещения в пути — принять", hint: "пришло с другого склада", wide: true, link: "/warehouse-transfers",
    available: (u) => hasPerm(u, "warehouse_transfers.manage"), render: () => <TransfersInTransit />,
  },
  {
    key: "transfers-hub", title: "Перемещения к отправке", hint: "собрать и отправить на другой склад", wide: true, link: "/warehouse-transfers",
    available: (u) => hasPerm(u, "warehouse_transfers.manage"), render: () => <TransfersHub />,
  },
  {
    key: "my-orders", title: "Мои заказы", hint: "ваши заказы покупателей; черновик — «Отправить в производство» в строке", wide: true,
    link: "/customer-orders", available: (u) => hasPerm(u, "orders.request"), render: () => <MyOrdersWidget />,
  },
  {
    key: "intake", title: "Приём в производство", hint: "заказы покупателей ждут приёма — состав, потребность, принять сразу несколько", wide: true,
    link: "/customer-orders?section=intake", available: (u) => hasPerm(u, "production_tasks.manage"), render: () => <IntakeTab embedded />,
  },
  {
    key: "area-load", accent: "blue", title: "Загрузка участков", hint: "остаток заданий в рабочих днях — когда участок освободится", wide: false,
    link: "/planning", available: (u) => hasPerm(u, "production_tasks.manage", "production_tasks.view", "orders.request", "sales_calculator.view", "production_tasks.report"),
    render: () => <AreaLoadWidget />,
  },
  {
    key: "overdue", accent: "red", title: "Отставание", hint: "строки заданий, где план прошедших дней не сделан — с какого дня и сколько", wide: true,
    link: "/planner", available: (u) => hasPerm(u, "production_tasks.manage", "production_tasks.view", "production_tasks.report"),
    render: () => <OverdueWidget />,
  },
  {
    key: "deliveries", accent: "blue", title: "Ожидаемые поставки", hint: "заказано поставщику и ещё не пришло — по обещанной дате", wide: true,
    link: "/purchasing", available: (u) => hasPerm(u, "purchasing.manage", "units.receive"), render: () => <DeliveriesWidget />,
  },
  {
    key: "deadlines", accent: "blue", title: "Сроки и переносы", hint: "обещанные даты заказов и их переносы", wide: true,
    link: "/customer-orders?section=deadlines",
    available: (u) => hasPerm(u, "production_tasks.manage", "production_tasks.view", "orders.request", "sales_calculator.view", "plan.approve"),
    render: () => <OrderDeadlines />,
  },
  {
    key: "shortages", title: "Дефицит по заказам", hint: "чего не хватает заказам — заказать", wide: true, link: "/demand?tab=orders",
    available: (u) => hasPerm(u, "production_tasks.manage", "production_tasks.view", "purchasing.manage", "orders.request"),
    render: () => <ShortagesTab />,
  },
  {
    key: "materials-demand", title: "Материалы: что заказать", hint: "под задания и до мин. остатка — «Заявка» в строке", wide: true,
    link: "/demand?tab=components",
    available: (u) => hasPerm(u, "production_tasks.manage", "production_tasks.view", "materials.manage", "purchasing.manage", "units.receive"),
    render: () => <MaterialsDemand />,
  },
  {
    key: "reorder", title: "Плёнка: пора заказывать", hint: "остаток на сколько дней, сколько заказать", wide: true, link: "/purchasing",
    available: (u) => hasPerm(u, "purchasing.manage"), render: () => <ReorderTab />,
  },
  {
    key: "summary", accent: "navy", title: "Сводка", hint: "требует внимания, производство, склад, закупки — как на прежнем «Обзоре»", wide: true,
    available: () => true, render: () => <Overview embedded />,
  },
];

export function renderModule(m: HomeModule, user: User): ReactNode {
  return m.key === "quick" ? <QuickActions user={user} /> : m.render();
}

/** Стандартный набор — по тому, что сотрудник делает (анализ действий 28.10). */
export function defaultModules(u: User): string[] {
  if (isMaster(u)) return ["my-area", "inbox", "quick", "overdue", "area-requests"];
  if (isWarehouse(u)) return ["inbox", "quick", "search", "film-issue", "transfers-in", "area-requests", "deliveries"];
  // начальник цеха (ведёт все участки): приём, загрузка, сроки
  if (hasPerm(u, "production_tasks.manage") && (u.is_superuser || !u.area || hasPerm(u, "production_tasks.all_areas")))
    return ["inbox", "area-load", "quick", "overdue", "intake", "deadlines", "summary"];
  // закупщик: что и когда заказывать
  if (hasPerm(u, "purchasing.manage")) return ["inbox", "quick", "deliveries", "reorder", "materials-demand", "shortages"];
  // менеджер: свои заказы, отправка в производство, сроки
  if (hasPerm(u, "orders.request")) return ["inbox", "quick", "my-orders", "deadlines"];
  return ["inbox", "quick", "search", "summary"];
}
