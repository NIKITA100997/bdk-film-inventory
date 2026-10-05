import { Card, Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import LabelTemplateAdmin from "./LabelTemplateAdmin";
import CalcSettingsAdmin from "./CalcSettingsAdmin";
import CurrencyRatesAdmin from "./CurrencyRatesAdmin";

/** Настройки системы одним экраном (30.09): параметры расчётов, макет
 * этикетки, валюты и курсы — вкладками по правам. */
export default function Settings() {
  const { user } = useAuth();
  const has = (code: string) => !!user?.is_superuser || !!user?.permissions.includes(code);
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(has("calc_settings.manage") ? [{ key: "calc", label: "Параметры расчётов", children: <CalcSettingsAdmin /> }] : []),
    ...(has("labels.manage") ? [{ key: "label", label: "Макет этикетки (100×40)", children: <LabelTemplateAdmin /> }] : []),
    ...(has("prices.manage") ? [{ key: "currencies", label: "Валюты и курсы", children: <CurrencyRatesAdmin /> }] : []),
  ];
  const wanted = params.get("tab");
  const active = tabs.some((t) => t.key === wanted) ? (wanted as string) : tabs[0]?.key;
  return (
    <Card title="Настройки">
      <Tabs activeKey={active} onChange={(k) => setParams({ tab: k }, { replace: true })} items={tabs} destroyOnHidden />
    </Card>
  );
}
