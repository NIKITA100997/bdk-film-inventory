import { Navigate, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import AppLayout from "./layout/AppLayout";
import { RequireAuth, RequirePermission } from "./auth/RoleGuard";
import { lazyPage } from "./utils/lazyPage";
import { RedirectToSection } from "./components/SectionTabs";
import { ITEM_VIEW_PERMISSIONS } from "./api/items";

const IssueHub = lazyPage(() => import("./pages/mobile/StockOpsHub").then((m) => ({ default: m.IssueHub })));
const ReceiveHub = lazyPage(() => import("./pages/mobile/StockOpsHub").then((m) => ({ default: m.ReceiveHub })));
const UnitCard = lazyPage(() => import("./pages/mobile/UnitCard"));
const PartUnitCard = lazyPage(() => import("./pages/mobile/PartUnitCard"));

const Stock = lazyPage(() => import("./pages/desktop/Stock"));
const StockRedirect = lazyPage(() => import("./pages/desktop/Stock").then((m) => ({ default: m.StockRedirect })));
const Reports = lazyPage(() => import("./pages/desktop/Reports"));
const OrderPage = lazyPage(() => import("./pages/desktop/production/OrderPage"));
const PricesPage = lazyPage(() => import("./pages/desktop/PricesTab").then((m) => ({ default: m.PricesPage })));
const WarehouseTransfers = lazyPage(() => import("./pages/desktop/WarehouseTransfers"));
const Inventory = lazyPage(() => import("./pages/desktop/Inventory"));
const UserAdmin = lazyPage(() => import("./pages/desktop/UserAdmin"));
const RoleAdmin = lazyPage(() => import("./pages/desktop/RoleAdmin"));
const Purchasing = lazyPage(() => import("./pages/desktop/Purchasing"));
const SalesCalculator = lazyPage(() => import("./pages/desktop/SalesCalculator"));
const ProductionTasks = lazyPage(() => import("./pages/desktop/ProductionTasks"));
const Demand = lazyPage(() => import("./pages/desktop/production/Demand"));
const Settings = lazyPage(() => import("./pages/desktop/Settings"));
const Reconciliation = lazyPage(() => import("./pages/desktop/Reconciliation"));
const ProductionOrders = lazyPage(() => import("./pages/desktop/production/ProductionOrders"));
const Planning = lazyPage(() => import("./pages/desktop/Planning"));
const Requests = lazyPage(() => import("./pages/desktop/Requests"));
const Nomenclature = lazyPage(() => import("./pages/desktop/Nomenclature"));
const ItemCard = lazyPage(() => import("./pages/desktop/ItemCard"));
const MaterialCardRedirect = lazyPage(() => import("./pages/desktop/ItemCard").then((m) => ({ default: m.MaterialCardRedirect })));
const PartCardRedirect = lazyPage(() => import("./pages/desktop/ItemCard").then((m) => ({ default: m.PartCardRedirect })));
const PeriodClosing = lazyPage(() => import("./pages/desktop/PeriodClosing"));
const Productivity = lazyPage(() => import("./pages/desktop/Productivity"));
const ProductionMonitor = lazyPage(() => import("./pages/desktop/production/ProductionMonitor"));
const SearchPage = lazyPage(() => import("./pages/desktop/SearchPage"));
const ShipmentSchedule = lazyPage(() => import("./pages/desktop/ShipmentSchedule"));
const CustomerOrdersHub = lazyPage(() => import("./pages/desktop/customerOrders/CustomerOrdersHub"));
const FilmIssueBoard = lazyPage(() => import("./pages/desktop/FilmIssueBoard"));
const CustomerOrderPage = lazyPage(() => import("./pages/desktop/customerOrders/CustomerOrderPage"));

/** Экраны программы внутри шапки и меню. Отдельным списком, чтобы каждая
 * рабочая вкладка (layout/WorkspaceTabs.tsx) могла отрисовать свой экран по
 * своему адресу, а открытые вкладки не пересоздавались при переключении. */
const appPageRoutes = (
  <>
    <Route path="/" element={<Home />} />

    {/* 14.10: приёмка и выдача любой позиции — вид переключателем (?kind=) */}
    <Route path="/m/receive" element={<RequirePermission permissions={["units.receive", "materials.manage", "part_units.manage"]}><ReceiveHub /></RequirePermission>} />
    <Route path="/m/initial-stock" element={<Navigate to="/m/receive?mode=nodoc" replace />} />
    {/* 15.10: задания на выдачу плёнки — кладовщику и начальнику цеха */}
    <Route
      path="/film-issue"
      element={<RequirePermission permissions={["units.issue", "production_tasks.manage", "production_tasks.view"]}><FilmIssueBoard /></RequirePermission>}
    />
    <Route path="/m/issue" element={<RequirePermission permissions={["units.issue", "units.return", "part_units.manage"]}><IssueHub /></RequirePermission>} />
    <Route path="/blanks" element={<StockRedirect kind="film" tab="free" />} />
    <Route
      path="/m/unit-card"
      element={
        <RequirePermission
          permissions={["units.place", "units.writeoff", "units.split", "units.issue", "units.cut", "units.return"]}
        >
          <UnitCard />
        </RequirePermission>
      }
    />
    <Route
      path="/m/part-unit-card"
      element={
        <RequirePermission permissions={["part_units.manage", "part_units.view"]}>
          <PartUnitCard />
        </RequirePermission>
      }
    />
    {/* "Остатки"/"Карточка материала" видны любому аутентифицированному
    пользователю (как раньше ALL_ROLES) — /materials не пункт меню (8.1
    раздел бэклога доработок), вход только кликом по строке или сканом QR,
    поэтому доступ держим таким же широким, как у самого /stock. */}
    {/* Единые «Остатки» (плёнка и п/ф); старые адреса ведут сюда же. */}
    <Route path="/stock" element={<Stock />} />
    <Route path="/search" element={<SearchPage />} />
    {/* 14.10: сроки и готовность — вкладками «Заказов клиентов» */}
    <Route path="/order-deadlines" element={<RedirectToSection to="/customer-orders" section="deadlines" />} />
    <Route
      path="/planning"
      element={
        <RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report", "plan.approve"]}>
          <Planning />
        </RequirePermission>
      }
    />
    {/* 14.10: планирование — одним пунктом; старые адреса ведут на вкладки */}
    <Route path="/weekly-plan" element={<RedirectToSection to="/planning" section="week" />} />
    <Route path="/planner" element={<RedirectToSection to="/planning" section="planner" />} />
    <Route path="/production-calendar" element={<RedirectToSection to="/planning" section="calendar" />} />
    <Route
      path="/customer-orders/:id"
      element={<RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report", "orders.request", "sales_calculator.view", "plan.approve"]}><CustomerOrderPage /></RequirePermission>}
    />
    <Route
      path="/customer-orders"
      element={<RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report", "orders.request", "sales_calculator.view", "plan.approve", "fg.ship"]}><CustomerOrdersHub /></RequirePermission>}
    />
    <Route
      path="/shipment-schedule"
      element={
        <RequirePermission permissions={["orders.request", "sales_calculator.view", "production_tasks.manage", "production_tasks.view"]}>
          <ShipmentSchedule />
        </RequirePermission>
      }
    />
    <Route path="/materials" element={<MaterialCardRedirect />} />
    {/* Раздел 6 плана «Детали/П/ф остатки» — сквозной ERP-справочник
    по всем доменам сразу, виден так же широко, как сам /stock (сам
    экран внутри уже сужает п/ф-часть по part_units.view/manage). */}
    <Route path="/general-stock" element={<StockRedirect kind="all" tab="items" />} />
    <Route path="/storage-places" element={<StockRedirect kind="all" tab="map" />} />

    <Route
      path="/reports"
      element={<RequirePermission permissions={["reports.view"]}><Reports /></RequirePermission>}
    />
    <Route path="/economics" element={<Navigate to="/reports?group=production" replace />} />
    <Route
      path="/defects"
      element={<Navigate to="/reports?group=defects" replace />}
    />
    {/* 14.10: журнал действий — это общий журнал движений («Остатки → Всё → Движения») */}
    <Route path="/action-log" element={<Navigate to="/stock?kind=all&tab=movements" replace />} />
    {/* "Стеллажи" видны всем (как "Остатки") — вкладка "Управление" внутри
    сама решает, показываться ли, по storage.manage. */}
    <Route path="/storage" element={<StockRedirect kind="film" tab="map" />} />
    <Route
      path="/warehouse-transfers"
      element={
        <RequirePermission permissions={["warehouse_transfers.manage"]}>
          <WarehouseTransfers />
        </RequirePermission>
      }
    />
    <Route
      path="/calc-settings"
      element={<Navigate to="/settings?tab=calc" replace />}
    />
    <Route
      path="/dictionaries"
      element={<Navigate to="/nomenclature?tab=dicts" replace />}
    />
    <Route
      path="/users"
      element={<RequirePermission permissions={["users.manage"]}><UserAdmin /></RequirePermission>}
    />
    <Route
      path="/roles"
      element={<RequirePermission permissions={["users.manage"]}><RoleAdmin /></RequirePermission>}
    />
    {/* 14.10: участки и линии — в «Настройках»; запросы — одним пунктом */}
    <Route path="/areas" element={<RedirectToSection to="/settings" section="areas" />} />
    {/* мои запросы — всем; ждущие решения — тем, кто подтверждает (проверяет сервер) */}
    <Route path="/requests" element={<Requests />} />
    <Route path="/action-requests" element={<RedirectToSection to="/requests" section="actions" />} />
    <Route
      path="/productivity"
      element={<RequirePermission permissions={["reports.view", "production_tasks.view", "production_tasks.manage"]}><Productivity /></RequirePermission>}
    />
    <Route
      path="/period-closing"
      element={<RequirePermission permissions={["period.manage"]}><PeriodClosing /></RequirePermission>}
    />
    <Route path="/deletion-requests" element={<RedirectToSection to="/requests" section="deletions" />} />
    <Route
      path="/label-template"
      element={<Navigate to="/settings?tab=label" replace />}
    />
    <Route
      path="/settings"
      element={<RequirePermission permissions={["labels.manage", "calc_settings.manage", "prices.manage", "users.manage", "production_tasks.manage"]}><Settings /></RequirePermission>}
    />
    <Route
      path="/inventory"
      element={<RequirePermission permissions={["inventory.manage", "part_units.count", "units.receive", "materials.manage", "production_tasks.manage", "part_units.manage", "fg.ship"]}><Inventory /></RequirePermission>}
    />
    <Route
      path="/production-tasks"
      element={
        <RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report"]}>
          <ProductionTasks />
        </RequirePermission>
      }
    />
    <Route path="/product-models" element={<Navigate to="/nomenclature?tab=models" replace />} />
    <Route path="/parts" element={<Navigate to="/nomenclature?kind=pf" replace />} />
    <Route
      path="/production-lines"
      element={
        <Navigate to="/areas?tab=lines" replace />
      }
    />
    <Route
      path="/prices"
      element={<RequirePermission permissions={["prices.view", "prices.manage"]}><PricesPage /></RequirePermission>}
    />
    <Route
      path="/nomenclature"
      element={
        <RequirePermission permissions={["materials.manage", "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view"]}>
          <Nomenclature />
        </RequirePermission>
      }
    />
    <Route
      path="/production-orders/:id"
      element={<RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report", "sales_calculator.view", "orders.request"]}><OrderPage /></RequirePermission>}
    />
    <Route
      path="/production-orders"
      element={
        <RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report", "sales_calculator.view", "orders.request"]}>
          <ProductionOrders />
        </RequirePermission>
      }
    />

    <Route
      path="/demand"
      element={
        <RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view", "units.issue", "purchasing.manage", "orders.request"]}>
          <Demand />
        </RequirePermission>
      }
    />
    <Route path="/pf-demand" element={<Navigate to="/demand?tab=pf" replace />} />
    <Route
      path="/roll-reconciliation"
      element={
        <RequirePermission permissions={["units.issue", "units.return", "production_tasks.manage", "reports.view"]}>
          <Reconciliation />
        </RequirePermission>
      }
    />
    <Route
      path="/area-tasks"
      element={<Navigate to="/production-tasks" replace />}
    />
    <Route path="/door-series" element={<Navigate to="/nomenclature?tab=types" replace />} />
    <Route path="/part-units" element={<StockRedirect kind="pf" tab="lots" />} />
    <Route
      path="/item/:id"
      element={
        <RequirePermission permissions={ITEM_VIEW_PERMISSIONS}>
          <ItemCard />
        </RequirePermission>
      }
    />
    <Route
      path="/part-card"
      element={
        <RequirePermission permissions={["part_units.manage", "part_units.view"]}>
          <PartCardRedirect />
        </RequirePermission>
      }
    />
    <Route path="/part-stock" element={<StockRedirect kind="pf" tab="items" />} />
    <Route path="/part-storage" element={<StockRedirect kind="pf" tab="map" />} />
    <Route
      path="/purchasing"
      element={<RequirePermission permissions={["purchasing.manage"]}><Purchasing /></RequirePermission>}
    />
    {/* 14.10: отгрузка — вкладкой «Заказов клиентов» */}
    <Route path="/shipments" element={<RedirectToSection to="/customer-orders" section="shipping" />} />
    <Route
      path="/production-monitor"
      element={
        <RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report", "reports.view"]}>
          <ProductionMonitor />
        </RequirePermission>
      }
    />
    <Route path="/order-readiness" element={<RedirectToSection to="/customer-orders" section="readiness" />} />
    <Route
      path="/sales-calculator"
      element={<RequirePermission permissions={["sales_calculator.view"]}><SalesCalculator /></RequirePermission>}
    />
  </>
);

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout pageRoutes={appPageRoutes} />
          </RequireAuth>
        }
      >
        {appPageRoutes}
      </Route>
    </Routes>
  );
}
