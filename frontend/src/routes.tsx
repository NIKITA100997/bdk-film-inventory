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

import WeeklyPlan from "./pages/desktop/WeeklyPlan";
import PlanFact from "./pages/desktop/PlanFact";
import Dashboard from "./pages/desktop/Dashboard";
import MaterialCard from "./pages/desktop/MaterialCard";
import Orders from "./pages/desktop/Orders";
import CuttingRecommendations from "./pages/desktop/CuttingRecommendations";
import Reports from "./pages/desktop/Reports";
import Settings from "./pages/desktop/Settings";

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
          element={<RequireRole roles={["nachalnik_uchastka", "kladovshchik"]}><Return /></RequireRole>}
        />
        <Route
          path="/m/search"
          element={
            <RequireRole roles={["kladovshchik", "operator_sklada", "nachalnik_uchastka", "logist"]}>
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

        <Route path="/plan" element={<RequireRole roles={["nachalnik_tsekha"]}><WeeklyPlan /></RequireRole>} />
        <Route
          path="/plan-fact"
          element={<RequireRole roles={["nachalnik_tsekha", "logist"]}><PlanFact /></RequireRole>}
        />
        <Route
          path="/dashboard"
          element={
            <RequireRole roles={["logist", "nachalnik_tsekha", "snabzhenets"]}>
              <Dashboard />
            </RequireRole>
          }
        />
        <Route
          path="/materials"
          element={
            <RequireRole roles={["logist", "nachalnik_tsekha", "snabzhenets"]}>
              <MaterialCard />
            </RequireRole>
          }
        />
        <Route path="/orders" element={<RequireRole roles={["logist"]}><Orders /></RequireRole>} />
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
          element={<RequireRole roles={["admin", "kladovshchik"]}><Settings /></RequireRole>}
        />
      </Route>
    </Routes>
  );
}
