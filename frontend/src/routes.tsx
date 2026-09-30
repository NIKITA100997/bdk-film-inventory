import { Navigate, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import AppLayout from "./layout/AppLayout";
import { RequireAuth, RequirePermission } from "./auth/RoleGuard";

import Receive from "./pages/mobile/Receive";
import Issue from "./pages/mobile/Issue";
import UnitCard from "./pages/mobile/UnitCard";
import PartUnitCard from "./pages/mobile/PartUnitCard";

import Stock, { StockRedirect } from "./pages/desktop/Stock";
import Reports from "./pages/desktop/Reports";
import Defects from "./pages/desktop/Defects";
import ActionLog from "./pages/desktop/ActionLog";
import WarehouseTransfers from "./pages/desktop/WarehouseTransfers";
import CalcSettingsAdmin from "./pages/desktop/CalcSettingsAdmin";
import DictionaryAdmin from "./pages/desktop/DictionaryAdmin";
import InventoryDesktop from "./pages/desktop/InventoryDesktop";
import UserAdmin from "./pages/desktop/UserAdmin";
import RoleAdmin from "./pages/desktop/RoleAdmin";
import LabelTemplateAdmin from "./pages/desktop/LabelTemplateAdmin";
import Purchasing from "./pages/desktop/Purchasing";
import SalesCalculator from "./pages/desktop/SalesCalculator";
import ProductionTasks from "./pages/desktop/ProductionTasks";
import Demand from "./pages/desktop/production/Demand";
import Reconciliation from "./pages/desktop/Reconciliation";
import AreasAndLines from "./pages/desktop/AreasAndLines";
import ProductionOrders from "./pages/desktop/production/ProductionOrders";
import Planner from "./pages/desktop/production/Planner";
import Nomenclature from "./pages/desktop/Nomenclature";
import ItemCard, { MaterialCardRedirect, PartCardRedirect } from "./pages/desktop/ItemCard";
import { ITEM_VIEW_PERMISSIONS } from "./api/items";
import DeletionRequests from "./pages/desktop/DeletionRequests";

/** Экраны программы внутри шапки и меню. Отдельным списком, чтобы каждая
 * рабочая вкладка (layout/WorkspaceTabs.tsx) могла отрисовать свой экран по
 * своему адресу, а открытые вкладки не пересоздавались при переключении. */
const appPageRoutes = (
  <>
    <Route path="/" element={<Home />} />

    <Route path="/m/receive" element={<RequirePermission permissions={["units.receive"]}><Receive /></RequirePermission>} />
    <Route path="/m/initial-stock" element={<Navigate to="/m/receive?mode=nodoc" replace />} />
    <Route path="/m/issue" element={<RequirePermission permissions={["units.issue", "units.return"]}><Issue /></RequirePermission>} />
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
    <Route
      path="/defects"
      element={<RequirePermission permissions={["reports.view"]}><Defects /></RequirePermission>}
    />
    <Route
      path="/action-log"
      element={<RequirePermission permissions={["reports.view"]}><ActionLog /></RequirePermission>}
    />
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
      element={<RequirePermission permissions={["calc_settings.manage"]}><CalcSettingsAdmin /></RequirePermission>}
    />
    <Route
      path="/dictionaries"
      element={<RequirePermission permissions={["materials.manage"]}><DictionaryAdmin /></RequirePermission>}
    />
    <Route
      path="/users"
      element={<RequirePermission permissions={["users.manage"]}><UserAdmin /></RequirePermission>}
    />
    <Route
      path="/roles"
      element={<RequirePermission permissions={["users.manage"]}><RoleAdmin /></RequirePermission>}
    />
    <Route
      path="/areas"
      element={<RequirePermission permissions={["users.manage", "production_tasks.manage"]}><AreasAndLines /></RequirePermission>}
    />
    <Route
      path="/deletion-requests"
      element={<RequirePermission permissions={["users.manage"]}><DeletionRequests /></RequirePermission>}
    />
    <Route
      path="/label-template"
      element={<RequirePermission permissions={["labels.manage"]}><LabelTemplateAdmin /></RequirePermission>}
    />
    <Route
      path="/inventory"
      element={<RequirePermission permissions={["inventory.manage"]}><InventoryDesktop /></RequirePermission>}
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
      path="/nomenclature"
      element={
        <RequirePermission permissions={["materials.manage", "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view"]}>
          <Nomenclature />
        </RequirePermission>
      }
    />
    <Route
      path="/production-orders"
      element={
        <RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report", "sales_calculator.view"]}>
          <ProductionOrders />
        </RequirePermission>
      }
    />
    <Route
      path="/planner"
      element={
        <RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "production_tasks.report"]}>
          <Planner />
        </RequirePermission>
      }
    />
    <Route
      path="/demand"
      element={
        <RequirePermission permissions={["production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view", "units.issue"]}>
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
    <Route
      path="/order-readiness"
      element={
        <RequirePermission
          permissions={["sales_calculator.view", "production_tasks.manage", "production_tasks.view", "production_tasks.report"]}
        >
          <Navigate to="/production-orders?view=readiness" replace />
        </RequirePermission>
      }
    />
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
