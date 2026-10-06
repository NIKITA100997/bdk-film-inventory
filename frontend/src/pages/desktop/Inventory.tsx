import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import InventoryDesktop from "./InventoryDesktop";
import PartCounts from "./PartCounts";

/** Инвентаризация (06.10): плёнка — сканом бирок по стеллажу/складу,
 * п/ф — пересчётом участка по партиям (бирок у п/ф нет). Вкладки — по правам. */
export default function Inventory() {
  const { user } = useAuth();
  const has = (c: string) => !!user?.is_superuser || !!user?.permissions.includes(c);
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(has("inventory.manage") ? [{ key: "film", label: "Плёнка — по биркам", children: <InventoryDesktop /> }] : []),
    ...(has("part_units.count") ? [{ key: "pf", label: "П/ф — пересчёт участка", children: <PartCounts /> }] : []),
  ];
  const wanted = params.get("tab");
  const active = tabs.some((t) => t.key === wanted) ? wanted! : tabs[0]?.key;
  if (tabs.length === 1) return <>{tabs[0].children}</>;
  return <Tabs activeKey={active} onChange={(k) => setParams({ tab: k })} items={tabs} destroyOnHidden />;
}
