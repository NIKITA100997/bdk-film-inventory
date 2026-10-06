import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Divider, Grid, Segmented, Space, Tabs, Typography } from "antd";
import { useAuth } from "../../auth/AuthContext";
import MaterialsExplorer from "./MaterialsExplorer";
import StorageMap from "./StorageMap";
import Blanks from "./Blanks";
import PartStorage from "./PartStorage";
import PartStock from "./production/PartStock";
import PartUnits from "./production/PartUnits";
import { FgMovesTab, FgStockTab } from "./FinishedGoodsStock";
import GeneralStock from "./GeneralStock";
import StoragePlaces from "./StoragePlaces";
import { LotsTab, MovementsPanel } from "./StockLotsMovements";
import { MaterialMovesTab, MaterialsStockTab } from "./MaterialsStock";

export type StockKind = "film" | "pf" | "materials" | "fg" | "all";
export type StockTab = "items" | "lots" | "free" | "movements" | "map";

/** Остатки — один экран на плёнку, п/ф и материалы вместо четырёх («Остатки плёнки»,
 * «Остатки и стеллажи п/ф», «Партии п/ф», «Остатки и движения»). Вид
 * (плёнка / п/ф / всё) и вкладка — в адресе (?kind=&tab=). Во вкладках —
 * те же рабочие экраны со всеми их действиями, поэтому кладовщику и мастеру
 * не нужно никуда переходить: позиции, партии, движения и стеллажи своего
 * вида — здесь. «Всё» — сводка по обоим видам для планирования. */
export default function Stock() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // На узком экране вид — своей строкой, иначе вкладки уходят в «…».
  const wide = Grid.useBreakpoint().md ?? true;
  const has = (...perms: string[]) => !!user?.is_superuser || perms.some((p) => user?.permissions.includes(p));
  const canPf = has("part_units.view", "part_units.manage", "part_storage.manage");
  const canPfLots = has("part_units.view", "part_units.manage");
  const canFilmOps = !!user?.is_superuser || !!user?.permissions.some((p) => p.startsWith("units."));
  const canBlanks = has("units.issue");

  const kinds: { value: StockKind; label: string }[] = [
    { value: "film", label: "Плёнка" },
    ...(canPf ? [{ value: "pf" as const, label: "П/ф" }] : []),
    // Материалы (МДФ, пенопласт, клей, кромка…) — остаток одним числом.
    { value: "materials", label: "Материалы" },
    // готовая продукция (06.10): приход — из отчёта упаковки, расход — отгрузка
    { value: "fg", label: "Изделия" },
    ...(canPf ? [{ value: "all" as const, label: "Всё" }] : []),
  ];
  // По умолчанию — свой вид: у кого нет работы с плёнкой, но есть п/ф, — п/ф.
  // Поиск из шапки и переход из «Закупок» — всегда про плёнку.
  const filmState = !!(location.state as { globalQuery?: string; usualSupplierFilter?: string } | null)?.globalQuery ||
    !!(location.state as { usualSupplierFilter?: string } | null)?.usualSupplierFilter;
  const defaultKind: StockKind = canPf && !canFilmOps && !filmState ? "pf" : "film";
  const kindParam = params.get("kind") as StockKind | null;
  const kind: StockKind = kinds.some((k) => k.value === kindParam) ? (kindParam as StockKind) : defaultKind;

  const tabsByKind: Record<StockKind, { key: StockTab; label: string }[]> = {
    film: [
      { key: "items", label: "По позициям" },
      { key: "lots", label: "Рулоны и штрипсы" },
      ...(canBlanks ? [{ key: "free" as const, label: "Свободный остаток" }] : []),
      { key: "movements", label: "Движения" },
      { key: "map", label: "Стеллажи" },
    ],
    pf: [
      { key: "items", label: "По деталям" },
      ...(canPfLots ? [{ key: "lots" as const, label: "Партии" }] : []),
      { key: "movements", label: "Движения" },
      { key: "map", label: "Стеллажи" },
    ],
    materials: [
      { key: "items", label: "Остатки" },
      { key: "movements", label: "Движения" },
    ],
    fg: [
      { key: "items", label: "Остатки" },
      { key: "movements", label: "Движения" },
    ],
    all: [
      { key: "items", label: "По позициям" },
      { key: "lots", label: "По партиям" },
      { key: "movements", label: "Движения" },
      // Все стеллажи плёнки и п/ф одним справочником (бывшие «Места хранения»).
      { key: "map", label: "Стеллажи" },
    ],
  };
  const tabs = tabsByKind[kind];
  const tabParam = params.get("tab") as StockTab | null;
  const tab: StockTab = tabs.some((t) => t.key === tabParam) ? (tabParam as StockTab) : tabs[0].key;

  const go = (nextKind: StockKind, nextTab: StockTab) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("kind", nextKind);
        p.set("tab", nextTab);
        return p;
      },
      { replace: true },
    );

  let content: React.ReactNode;
  if (kind === "film") {
    content =
      tab === "items" || tab === "lots" ? (
        // Один и тот же экземпляр на обе вкладки — фильтры не сбрасываются.
        <MaterialsExplorer mode={tab === "lots" ? "units" : "positions"} />
      ) : tab === "free" ? (
        <Blanks />
      ) : tab === "movements" ? (
        <MovementsPanel fixedKind="plenka" />
      ) : (
        <StorageMap />
      );
  } else if (kind === "pf") {
    content =
      tab === "items" ? (
        <PartStock />
      ) : tab === "lots" ? (
        <PartUnits />
      ) : tab === "movements" ? (
        <MovementsPanel fixedKind="pf" />
      ) : (
        <PartStorage />
      );
  } else if (kind === "fg") {
    content = tab === "movements" ? <FgMovesTab /> : <FgStockTab />;
  } else if (kind === "materials") {
    content = tab === "movements" ? <MaterialMovesTab /> : <MaterialsStockTab />;
  } else {
    content =
      tab === "items" ? <GeneralStock /> : tab === "lots" ? <LotsTab /> : tab === "map" ? <StoragePlaces /> : <MovementsPanel />;
  }

  const kindSwitch =
    kinds.length > 1 ? (
      <Space size={8} style={{ marginRight: 8 }}>
        <Typography.Text type="secondary">Вид:</Typography.Text>
        <Segmented
          value={kind}
          options={kinds}
          onChange={(v) => go(v as StockKind, tabsByKind[v as StockKind].some((t) => t.key === tab) ? tab : "items")}
        />
        {wide && <Divider type="vertical" style={{ height: 24 }} />}
      </Space>
    ) : null;

  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      {!wide && kindSwitch}
      <Tabs
        activeKey={tab}
        onChange={(k) => go(kind, k as StockTab)}
        items={tabs.map((t) => ({ key: t.key, label: t.label }))}
        tabBarExtraContent={wide ? { left: kindSwitch } : undefined}
      />
      {content}
    </Space>
  );
}
/** Старые адреса остатков (/part-units, /storage, сканы стеллажей…) ведут
 * сюда с нужным видом и вкладкой; state (стеллаж со скана, открыть партию,
 * фильтр) переносится как есть. */
export function StockRedirect({ kind, tab }: { kind: StockKind; tab: StockTab }) {
  const location = useLocation();
  return <Navigate to={`/stock?kind=${kind}&tab=${tab}`} replace state={location.state} />;
}
