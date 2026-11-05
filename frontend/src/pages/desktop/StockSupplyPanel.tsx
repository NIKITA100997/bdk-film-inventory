import { Segmented, Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import AreaRequestsPanel from "../../components/areaSupply/AreaRequestsPanel";
import AreaNormsPanel from "../../components/areaSupply/AreaNormsPanel";

const SUPPLIES = [
  { value: "all", label: "Всё снабжение" },
  { value: "plenka", label: "Плёнка" },
  { value: "pf", label: "ПФ" },
  { value: "material", label: "Материалы" },
] as const;

export default function StockSupplyPanel() {
  const [params, setParams] = useSearchParams();
  const supply = SUPPLIES.find((item) => item.value === params.get("supply"))?.value ?? "all";
  const kind = supply === "all" ? undefined : supply;
  const sub = params.get("sub") === "norms" ? "norms" : "requests";
  return (
    <div>
      <Segmented
        value={supply}
        options={SUPPLIES.map((item) => item)}
        onChange={(value) => setParams((prev) => {
          const next = new URLSearchParams(prev);
          if (value === "all") next.delete("supply");
          else next.set("supply", String(value));
          return next;
        }, { replace: true })}
        style={{ marginBottom: 8 }}
      />
      <Tabs
        activeKey={sub}
        destroyOnHidden
        onChange={(value) => setParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("sub", value);
          return next;
        }, { replace: true })}
        items={[
          { key: "requests", label: "Заявки участков", children: <AreaRequestsPanel kind={kind} /> },
          { key: "norms", label: "Нормы участков", children: <AreaNormsPanel kind={kind} /> },
        ]}
      />
    </div>
  );
}
