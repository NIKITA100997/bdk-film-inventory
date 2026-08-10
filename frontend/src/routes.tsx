import { Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import AppLayout from "./layout/AppLayout";
import { RequireAuth, RequireRole } from "./auth/RoleGuard";

import Receive from "./pages/mobile/Receive";
import Split from "./pages/mobile/Split";
import Cut from "./pages/mobile/Cut";
import Issue from "./pages/mobile/Issue";
import Return from "./pages/mobile/Return";
import Search from "./pages/mobile/Search";
import Place from "./pages/mobile/Place";
import Inventory from "./pages/mobile/Inventory";
import MyArea from "./pages/mobile/MyArea";

import WeeklyPlan from "./pages/desktop/WeeklyPlan";
import PlanFact from "./pages/desktop/PlanFact";
import Dashboard from "./pages/desktop/Dashboard";
import MaterialCard from "./pages/desktop/MaterialCard";
import Orders from "./pages/desktop/Orders";
import CuttingRecommendations from "./pages/desktop/CuttingRecommendations";
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
        <Route path="/m/split" element={<RequireRole roles={["operator_sklada"]}><Split /></RequireRole>} />
        <Route path="/m/issue" element={<RequireRole roles={["operator_sklada"]}><Issue /></RequireRole>} />
        <Route
          path="/m/cut"
          element={<RequireRole roles={["operator_sklada", "nachalnik_uchastka"]}><Cut /></RequireRole>}
        />
        <Route
          path="/m/return"
          element={
            <RequireRole roles={["nachalnik_uchastka", "kladovshchik", "operator_sklada"]}>
              <Return />
            </RequireRole>
          }
        />
        <Route
          path="/m/search"
          element={
            <RequireRole
              roles={["kladovshchik", "operator_sklada", "nachalnik_uchastka", "logist", "nachalnik_tsekha", "snabzhenets"]}
            >
              <Search />
            </RequireRole>
          }
        />
        <Route
          path="/m/place"
          element={<RequireRole roles={["kladovshchik", "operator_sklada"]}><Place /></RequireRole>}
        />
        <Route
          path="/m/inventory"
          element={<RequireRole roles={["logist", "kladovshchik"]}><Inventory /></RequireRole>}
        />
        <Route
          path="/m/my-area"
          element={<RequireRole roles={["nachalnik_uchastka"]}><MyArea /></RequireRole>}
        />

        <Route path="/plan" element={<RequireRole roles={["nachalnik_tsekha"]}><WeeklyPlan /></RequireRole>} />
        <Route
          path="/plan-fact"
          element={<RequireRole roles={["nachalnik_tsekha", "logist"]}><PlanFact /></RequireRole>}
        />
        <Route
          path="/dashboard"
          element={
            <RequireRole roles={["operator_sklada", "kladovshchik", "logist"]}>
              <Dashboard />
            </RequireRole>
          }
        />
        <Route
          path="/materials"
          element={
            // Доступен и с десктопного раздела "Материалы" (сузили до
            // operator_sklada/kladovshchik/logist — 5.5 ТЗ), и с мобильного
            // блока "Общее" (там пункт открыт всем ролям), поэтому здесь
            // держим полный список, чтобы не сломать мобильный вход.
            <RequireRole
              roles={["operator_sklada", "kladovshchik", "nachalnik_uchastka", "nachalnik_tsekha", "logist", "snabzhenets"]}
            >
              <MaterialCard />
            </RequireRole>
          }
        />
        <Route path="/orders" element={<RequireRole roles={["logist", "kladovshchik"]}><Orders /></RequireRole>} />
        <Route
          path="/recommendations"
          element={
            <RequireRole roles={["logist", "kladovshchik", "operator_sklada"]}>
              <CuttingRecommendations />
            </RequireRole>
          }
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
