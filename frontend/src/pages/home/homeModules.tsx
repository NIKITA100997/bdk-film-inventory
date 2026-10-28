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
    key: "quick", title: "Быстрые действия", hint: "кнопки ваших ежедневных операций", wide: false,
    available: () => true, render: () => null, // подставляется с пользователем, см. renderModule
  },
  {
    key: "search", title: "Найти", hint: "рулон, партия, задание, заказ — по номеру или скану", wide: false,
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
    key: "summary", title: "Сводка", hint: "требует внимания, производство, склад, закупки — как на прежнем «Обзоре»", wide: true,
    available: () => true, render: () => <Overview embedded />,
  },
];

export function renderModule(m: HomeModule, user: User): ReactNode {
  return m.key === "quick" ? <QuickActions user={user} /> : m.render();
}

/** Стандартный набор — по тому, что сотрудник делает (анализ действий 28.10). */
export function defaultModules(u: User): string[] {
  if (isMaster(u)) return ["my-area", "inbox", "quick", "area-requests"];
  if (isWarehouse(u)) return ["inbox", "quick", "search", "film-issue", "transfers-in", "area-requests"];
  return ["inbox", "quick", "search", "summary"];
}
