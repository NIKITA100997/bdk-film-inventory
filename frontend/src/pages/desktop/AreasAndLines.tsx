import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import AreaAdmin from "./AreaAdmin";
import ProductionLines from "./ProductionLines";

/** Устройство цеха одним экраном: площадки и участки, линии участков.
 * Вкладки — по правам: участки правит администратор, линии — начальник цеха. */
export default function AreasAndLines() {
  const { user } = useAuth();
  const has = (code: string) => !!user?.is_superuser || !!user?.permissions.includes(code);
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(has("users.manage") ? [{ key: "areas", label: "Площадки и участки", children: <AreaAdmin /> }] : []),
    ...(has("production_tasks.manage") ? [{ key: "lines", label: "Линии", children: <ProductionLines /> }] : []),
  ];
  const wanted = params.get("tab");
  const active = tabs.some((t) => t.key === wanted) ? (wanted as string) : tabs[0]?.key;
  return <Tabs activeKey={active} onChange={(k) => setParams({ tab: k }, { replace: true })} items={tabs} destroyOnHidden />;
}
