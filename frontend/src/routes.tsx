import { Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import AppLayout from "./layout/AppLayout";
import { RequireAuth, RequirePermission } from "./auth/RoleGuard";

import Receive from "./pages/mobile/Receive";
import Issue from "./pages/mobile/Issue";
import UnitCard from "./pages/mobile/UnitCard";

import MaterialsExplorer from "./pages/desktop/MaterialsExplorer";
import MaterialCard from "./pages/desktop/MaterialCard";
import Reports from "./pages/desktop/Reports";
import StorageMap from "./pages/desktop/StorageMap";
import CalcSettingsAdmin from "./pages/desktop/CalcSettingsAdmin";
import DictionaryAdmin from "./pages/desktop/DictionaryAdmin";
import InventoryDesktop from "./pages/desktop/InventoryDesktop";
import UserAdmin from "./pages/desktop/UserAdmin";
import RoleAdmin from "./pages/desktop/RoleAdmin";
import LabelTemplateAdmin from "./pages/desktop/LabelTemplateAdmin";
import Purchasing from "./pages/desktop/Purchasing";
import SalesCalculator from "./pages/desktop/SalesCalculator";
import ProductionTasks from "./pages/desktop/ProductionTasks";
import ProductModels from "./pages/desktop/ProductModels";
import ProductionLines from "./pages/desktop/ProductionLines";
import AreaAdmin from "./pages/desktop/AreaAdmin";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Home />} />

        <Route path="/m/receive" element={<RequirePermission permissions={["units.receive"]}><Receive /></RequirePermission>} />
        <Route path="/m/issue" element={<RequirePermission permissions={["units.issue"]}><Issue /></RequirePermission>} />
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
        {/* "Остатки"/"Карточка материала" видны любому аутентифицированному
        пользователю (как раньше ALL_ROLES) — /materials не пункт меню (8.1
        раздел бэклога доработок), вход только кликом по строке или сканом QR,
        поэтому доступ держим таким же широким, как у самого /stock. */}
        <Route path="/stock" element={<MaterialsExplorer />} />
        <Route path="/materials" element={<MaterialCard />} />

        <Route
          path="/reports"
          element={<RequirePermission permissions={["reports.view"]}><Reports /></RequirePermission>}
        />
        {/* "Стеллажи" видны всем (как "Остатки") — вкладка "Управление" внутри
        сама решает, показываться ли, по storage.manage. */}
        <Route path="/storage" element={<StorageMap />} />
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
          element={<RequirePermission permissions={["users.manage"]}><AreaAdmin /></RequirePermission>}
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
            <RequirePermission permissions={["production_tasks.manage", "production_tasks.view"]}>
              <ProductionTasks />
            </RequirePermission>
          }
        />
        <Route
          path="/product-models"
          element={
            <RequirePermission permissions={["production_tasks.manage"]}>
              <ProductModels />
            </RequirePermission>
          }
        />
        <Route
          path="/production-lines"
          element={
            <RequirePermission permissions={["production_tasks.manage"]}>
              <ProductionLines />
            </RequirePermission>
          }
        />
        <Route
          path="/purchasing"
          element={<RequirePermission permissions={["purchasing.manage"]}><Purchasing /></RequirePermission>}
        />
        <Route
          path="/sales-calculator"
          element={<RequirePermission permissions={["sales_calculator.view"]}><SalesCalculator /></RequirePermission>}
        />
      </Route>
    </Routes>
  );
}
