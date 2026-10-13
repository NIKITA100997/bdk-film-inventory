import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import InventoryDesktop from "./InventoryDesktop";
import PartCounts from "./PartCounts";
import CountSheet from "./inventory/CountSheet";
import { countMaterials, listMaterialStock } from "../../api/materialStock";
import { countFg, listFgStock } from "../../api/finishedGoods";
import { apiErrorMessage } from "../../utils/apiError";

/** Инвентаризация — одна на все виды (06.10; 14.10 — материалы и изделия):
 * плёнка — сканом бирок по стеллажу/складу, п/ф — пересчётом участка по
 * партиям (бирок у п/ф нет), материалы и склад ГП — пересчётом листом
 * (партий нет — остаток одним числом). Вкладки — по правам. */
export default function Inventory() {
  const { user } = useAuth();
  const has = (...c: string[]) => !!user?.is_superuser || c.some((x) => !!user?.permissions.includes(x));
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(has("inventory.manage") ? [{ key: "film", label: "Плёнка — по биркам", children: <InventoryDesktop /> }] : []),
    ...(has("part_units.count") ? [{ key: "pf", label: "П/ф — пересчёт участка", children: <PartCounts /> }] : []),
    ...(has("units.receive", "materials.manage", "production_tasks.manage", "part_units.manage")
      ? [{ key: "materials", label: "Материалы — пересчёт", children: <MaterialsCount /> }]
      : []),
    ...(has("fg.ship") ? [{ key: "fg", label: "Изделия — пересчёт", children: <FgCount /> }] : []),
  ];
  const wanted = params.get("tab");
  const active = tabs.some((t) => t.key === wanted) ? wanted! : tabs[0]?.key;
  if (tabs.length === 1) return <>{tabs[0].children}</>;
  return <Tabs activeKey={active} onChange={(k) => setParams({ tab: k })} items={tabs} destroyOnHidden />;
}

const fail = (e: unknown, text: string) => {
  throw new Error(apiErrorMessage(e, text));
};

function MaterialsCount() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["material-stock", false], queryFn: () => listMaterialStock(false) });
  const rows = (q.data ?? []).map((r) => ({ key: String(r.item_id), name: r.name, detail: r.group_name, unit: r.unit, book: r.balance }));
  return (
    <CountSheet
      rows={rows}
      loading={q.isLoading}
      hint="Материалы (МДФ, пенопласт, клей, кромка…): остаток одним числом на склад."
      onPost={async (doc, facts) => {
        try {
          const r = await countMaterials(doc, facts.map((f) => ({ item_id: Number(f.key), fact: f.fact })));
          for (const k of ["material-stock", "material-moves", "unified-movements"]) qc.invalidateQueries({ queryKey: [k] });
          return r;
        } catch (e) {
          return fail(e, "Не удалось провести пересчёт");
        }
      }}
    />
  );
}

function FgCount() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["fg-stock"], queryFn: listFgStock });
  const src = q.data ?? [];
  const rows = src.map((r, i) => ({
    key: String(i),
    name: r.item_name,
    detail: [r.site_name, r.invoice_no ? `счёт ${r.invoice_no}` : "без заказа"].filter(Boolean).join(" · "),
    unit: "шт",
    book: r.qty,
  }));
  return (
    <CountSheet
      rows={rows}
      loading={q.isLoading}
      hint="Готовые изделия на складах площадок — по позиции, площадке и счёту."
      onPost={async (doc, facts) => {
        try {
          const r = await countFg(
            doc,
            facts.map((f) => {
              const s = src[Number(f.key)];
              return { item_id: s.item_id, site_id: s.site_id, order_line_id: s.order_line_id, actual_qty: f.fact };
            }),
          );
          for (const k of ["fg-stock", "fg-moves", "unified-movements"]) qc.invalidateQueries({ queryKey: [k] });
          return r;
        } catch (e) {
          return fail(e, "Не удалось провести пересчёт");
        }
      }}
    />
  );
}
