import { Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import AppLayout from "./layout/AppLayout";
import { RequireAuth, RequireRole } from "./auth/RoleGuard";

import Receive from "./pages/mobile/Receive";
import Issue from "./pages/mobile/Issue";
import UnitCard from "./pages/mobile/UnitCard";
import Inventory from "./pages/mobile/Inventory";

import MaterialsExplorer from "./pages/desktop/MaterialsExplorer";
import MaterialCard from "./pages/desktop/MaterialCard";
import Orders from "./pages/desktop/Orders";
import Reports from "./pages/desktop/Reports";
import Settings from "./pages/desktop/Settings";
import DictionaryAdmin from "./pages/desktop/DictionaryAdmin";
import InventoryDesktop from "./pages/desktop/InventoryDesktop";
import UserAdmin from "./pages/desktop/UserAdmin";
import LabelTemplateAdmin from "./pages/desktop/LabelTemplateAdmin";
import Purchasing from "./pages/desktop/Purchasing";

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

        <Route path="/m/receive" element={<RequireRole roles={["operator_sklada"]}><Receive /></RequireRole>} />
        <Route path="/m/issue" element={<RequireRole roles={["operator_sklada"]}><Issue /></RequireRole>} />
        <Route
          path="/m/unit-card"
          element={
            <RequireRole roles={["operator_sklada", "nachalnik_uchastka", "kladovshchik"]}>
              <UnitCard />
            </RequireRole>
          }
        />
        <Route
          path="/m/inventory"
          element={<RequireRole roles={["logist", "kladovshchik"]}><Inventory /></RequireRole>}
        />

        <Route
          path="/stock"
          element={
            <RequireRole
              roles={["operator_sklada", "kladovshchik", "nachalnik_uchastka", "nachalnik_tsekha", "logist", "snabzhenets"]}
            >
              <MaterialsExplorer />
            </RequireRole>
          }
        />
        <Route
          path="/materials"
          element={
            // Не пункт меню (8.1 раздел бэклога доработок) — вход только
            // кликом по строке в "Остатках" или сканом QR, поэтому доступ
            // держим широким, как раньше был у самого /stock.
            <RequireRole
              roles={["operator_sklada", "kladovshchik", "nachalnik_uchastka", "nachalnik_tsekha", "logist", "snabzhenets"]}
            >
              <MaterialCard />
            </RequireRole>
          }
        />
        <Route
          path="/orders"
          element={<RequireRole roles={["logist", "kladovshchik", "nachalnik_tsekha"]}><Orders /></RequireRole>}
        />
        <Route
          path="/reports"
          element={<RequireRole roles={["logist", "nachalnik_tsekha"]}><Reports /></RequireRole>}
        />
        <Route
          path="/settings"
          element={<RequireRole roles={["logist"]}><Settings /></RequireRole>}
        />
        <Route
          path="/dictionaries"
          element={<RequireRole roles={["logist"]}><DictionaryAdmin /></RequireRole>}
        />
        <Route
          path="/users"
          element={<RequireRole roles={["logist"]}><UserAdmin /></RequireRole>}
        />
        <Route
          path="/label-template"
          element={<RequireRole roles={["logist"]}><LabelTemplateAdmin /></RequireRole>}
        />
        <Route
          path="/inventory"
          element={<RequireRole roles={["logist", "kladovshchik"]}><InventoryDesktop /></RequireRole>}
        />
        <Route
          path="/purchasing"
          element={<RequireRole roles={["snabzhenets"]}><Purchasing /></RequireRole>}
        />
      </Route>
    </Routes>
  );
}
