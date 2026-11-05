import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { hasPerm } from "../../auth/permissions";
import { lazyPage } from "../../utils/lazyPage";

const RollReconciliationTab = lazyPage(() => import("./production/RollReconciliationTab"));
const UnitReconciliationTab = lazyPage(() => import("./Reports").then((m) => ({ default: m.UnitReconciliationTab })));

export default function FilmReconciliationPanel() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const items = [
    ...(hasPerm(user, "units.issue", "units.return", "production_tasks.manage")
      ? [{ key: "rolls", label: "Сверка рулонов", children: <RollReconciliationTab /> }]
      : []),
    ...(hasPerm(user, "reports.view")
      ? [{ key: "meters", label: "Расхождения метража", children: <UnitReconciliationTab /> }]
      : []),
  ];
  const requested = params.get("recon");
  const active = items.some((item) => item.key === requested) ? requested! : items[0]?.key;
  return (
    <Tabs
      activeKey={active}
      destroyOnHidden
      onChange={(key) => setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("recon", key);
        return next;
      }, { replace: true })}
      items={items}
    />
  );
}
