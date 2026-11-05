import { useMemo } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, Grid, Segmented, Space, Tabs, Typography } from "antd";
import { useAuth } from "../../auth/AuthContext";
import MaterialsExplorer from "./MaterialsExplorer";
import StorageMap from "./StorageMap";
import Blanks from "./Blanks";
import PartStorage from "./PartStorage";
import PartStock from "./production/PartStock";
import PartUnits from "./production/PartUnits";
import { FgStockTab } from "./FinishedGoodsStock";
import StoragePlaces from "./StoragePlaces";
import { LotsTab, MovementsPanel } from "./StockLotsMovements";
import { MaterialsStockTab } from "./MaterialsStock";
import { lazyPage } from "../../utils/lazyPage";

const StockSupplyPanel = lazyPage(() => import("./StockSupplyPanel"));

export type StockKind = "film" | "pf" | "materials" | "fg" | "all";
export type StockTab = "items" | "lots" | "free" | "movements" | "map" | "requests";

/** Остатки — единый WMS-терминал на плёнку, п/ф, материалы и изделия.
 * Приёмка и выдача плёнки находятся в рабочем месте «Плёнка»; здесь собраны остатки,
 * движения, заявки снабжения, маршруты сборки и инвентаризация.
 * 4 ключевые вкладки: «По позициям», «Рулоны и партии», «Движения», «Стеллажи»
 * с переключателем вида («Плёнка», «П/ф», «Материалы», «Изделия», «Всё»). */
export default function Stock() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const wide = screens.md ?? true;

  const has = (...perms: string[]) =>
    !!user?.is_superuser || perms.some((p) => user?.permissions.includes(p));

  const canPf = has("part_units.view", "part_units.manage", "part_storage.manage");
  const canFilmOps = !!user?.is_superuser || !!user?.permissions.some((p) => p.startsWith("units."));
  const canBlanks = has("units.issue");
  const canInventory = has("inventory.manage", "part_units.count");
  const canSupplyRequests = has("production_tasks.report", "production_tasks.manage", "units.issue");

  const kinds: { value: StockKind; label: string }[] = useMemo(
    () => [
      { value: "film", label: "Плёнка" },
      ...(canPf ? [{ value: "pf" as const, label: "П/ф" }] : []),
      { value: "materials", label: "Материалы" },
      { value: "fg", label: "Изделия" },
      ...(canPf || has("reports.view") ? [{ value: "all" as const, label: "Всё" }] : []),
    ],
    [canPf, user]
  );

  const mainTabs: { key: StockTab; label: string }[] = useMemo(
    () => [
      { key: "items", label: "📦 По позициям" },
      { key: "lots", label: "🏷️ Рулоны и партии" },
      ...(canBlanks ? [{ key: "free" as const, label: "✂️ Свободный остаток" }] : []),
      { key: "movements", label: "🔄 Движения" },
      { key: "map", label: "🗺️ Стеллажи" },
      ...(canSupplyRequests ? [{ key: "requests" as const, label: "📨 Заявки участков" }] : []),
    ],
    [canBlanks, canSupplyRequests]
  );

  const filmState =
    !!(location.state as { globalQuery?: string; usualSupplierFilter?: string } | null)?.globalQuery ||
    !!(location.state as { usualSupplierFilter?: string } | null)?.usualSupplierFilter;

  const defaultKind: StockKind = canPf && !canFilmOps && !filmState ? "pf" : "film";
  const kindParam = params.get("kind") as StockKind | null;
  const tabParam = params.get("tab") as StockTab | null;

  const tab: StockTab = mainTabs.some((t) => t.key === tabParam)
    ? (tabParam as StockTab)
    : mainTabs[0].key;

  // Виды, доступные на текущей вкладке
  const availableKinds = useMemo(() => {
    if (tab === "requests") return [];
    if (tab === "items") return kinds.filter((k) => k.value !== "all");
    if (tab === "map") return kinds.filter((k) => k.value === "film" || k.value === "pf" || k.value === "all");
    if (tab === "free") return [];
    return kinds;
  }, [tab, kinds]);

  const kind: StockKind = availableKinds.some((k) => k.value === kindParam)
    ? (kindParam as StockKind)
    : availableKinds.some((k) => k.value === defaultKind)
    ? defaultKind
    : availableKinds[0]?.value ?? "film";

  const go = (nextKind: StockKind, nextTab: StockTab) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("kind", nextKind);
        p.set("tab", nextTab);
        return p;
      },
      { replace: true }
    );

  let content: React.ReactNode;
  if (tab === "items") {
    if (kind === "pf") content = <PartStock />;
    else if (kind === "materials") content = <MaterialsStockTab />;
    else if (kind === "fg") content = <FgStockTab />;
    else content = <MaterialsExplorer mode="positions" />;
  } else if (tab === "lots") {
    if (kind === "pf") content = <PartUnits />;
    else if (kind === "film") content = <MaterialsExplorer mode="units" />;
    else content = <LotsTab />;
  } else if (tab === "free") {
    content = <Blanks />;
  } else if (tab === "movements") {
    const fixedKind =
      kind === "film"
        ? "plenka"
        : kind === "pf"
        ? "pf"
        : kind === "materials"
        ? "material"
        : kind === "fg"
        ? "fg"
        : undefined;
    content = (
      <MovementsPanel
        fixedKind={fixedKind}
        defaultDays={kind === "fg" || kind === "materials" ? 30 : undefined}
      />
    );
  } else if (tab === "map") {
    if (kind === "pf") content = <PartStorage />;
    else if (kind === "film") content = <StorageMap />;
    else content = <StoragePlaces />;
  } else if (tab === "requests") {
    content = <StockSupplyPanel />;
  }

  const kindSwitch =
    availableKinds.length > 1 ? (
      <Space size={6} wrap align="center" style={{ margin: "2px 0" }}>
        <Typography.Text type="secondary" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
          Вид:
        </Typography.Text>
        <Segmented
          size="small"
          value={kind}
          options={availableKinds}
          onChange={(v) => go(v as StockKind, tab)}
        />
      </Space>
    ) : null;

  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      {/* Быстрая панель ключевых операций склада (WMS) */}
      <Card
        size="small"
        styles={{ body: { padding: "8px 16px" } }}
        style={{ borderRadius: 8, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <Space align="center" size={8}>
            <span style={{ fontSize: 18 }}>📦</span>
            <Typography.Title level={5} style={{ margin: 0, whiteSpace: "nowrap" }}>
              Склад и Остатки
            </Typography.Title>
          </Space>
          <Space wrap size={6}>
            {canInventory && (
              <>
                <Button
                  size="small"
                  onClick={() => navigate("/inventory")}
                >
                  🔄 Инвентаризация
                </Button>
                <Button
                  size="small"
                  onClick={() => navigate("/inventory/express")}
                  style={{ borderColor: "#722ed1", color: "#722ed1" }}
                >
                  📱 Экспресс-ревизия
                </Button>
              </>
            )}
          </Space>
        </div>
      </Card>

      {!wide && kindSwitch}
      <Tabs
        activeKey={tab}
        onChange={(k) => go(kind, k as StockTab)}
        items={mainTabs.map((t) => ({ key: t.key, label: t.label }))}
        tabBarExtraContent={wide ? { right: kindSwitch } : undefined}
      />
      {content}
    </Space>
  );
}

export function StockRedirect({ kind, tab }: { kind: StockKind; tab: StockTab }) {
  const location = useLocation();
  return (
    <Navigate
      to={`/stock?kind=${kind}&tab=${tab}`}
      replace
      state={location.state}
    />
  );
}
