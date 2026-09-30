import { Card, Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import RollReconciliationTab from "./production/RollReconciliationTab";
import { PartUnitReconciliationTab, UnitReconciliationTab } from "./Reports";

/** Сверка — всё, что «не сходится», одним экраном склада: рулоны к разбору
 * (без задания / без отчёта — привязать, вернуть), расхождения метража
 * по рулонам (выдано ≠ расход + списано + остаток) и партии п/ф. */
export default function Reconciliation() {
  const { user } = useAuth();
  const has = (...codes: string[]) => !!user?.is_superuser || codes.some((c) => user?.permissions.includes(c));
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(has("units.issue", "units.return", "production_tasks.manage")
      ? [{ key: "rolls", label: "Рулоны: к разбору", children: <RollReconciliationTab /> }]
      : []),
    ...(has("reports.view")
      ? [
          { key: "meters", label: "Рулоны: расхождения метража", children: <UnitReconciliationTab /> },
          { key: "parts", label: "Партии п/ф", children: <PartUnitReconciliationTab /> },
        ]
      : []),
  ];
  const wanted = params.get("tab");
  const active = tabs.some((t) => t.key === wanted) ? (wanted as string) : tabs[0]?.key;
  if (tabs.length === 1)
    return (
      <Card title={`Сверка · ${tabs[0].label}`}>
        {tabs[0].children}
      </Card>
    );
  return (
    <Card title="Сверка">
      <Tabs activeKey={active} onChange={(k) => setParams({ tab: k }, { replace: true })} items={tabs} destroyOnHidden />
    </Card>
  );
}
