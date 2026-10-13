import { useAuth } from "../../auth/AuthContext";
import { hasPerm } from "../../auth/permissions";
import SectionTabs from "../../components/SectionTabs";
import Planner from "./production/Planner";
import WeeklyPlan from "./production/WeeklyPlan";
import ProductionCalendar from "./production/ProductionCalendar";

/** Планирование (14.10) — одним пунктом меню вместо трёх: планировщик
 * (сроки по участкам), план недели (утверждение), производственный календарь. */
export default function Planning() {
  const { user } = useAuth();
  const sections = [
    ...(hasPerm(user, "production_tasks.manage", "production_tasks.view", "production_tasks.report")
      ? [{ key: "planner", label: "Планировщик", children: <Planner /> }]
      : []),
    ...(hasPerm(user, "production_tasks.manage", "production_tasks.view", "plan.approve") ? [{ key: "week", label: "План недели", children: <WeeklyPlan /> }] : []),
    ...(hasPerm(user, "production_tasks.manage", "production_tasks.view") ? [{ key: "calendar", label: "Производственный календарь", children: <ProductionCalendar /> }] : []),
  ];
  return <SectionTabs title="Планирование" sections={sections} />;
}
