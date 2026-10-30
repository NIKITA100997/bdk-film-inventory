import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, Divider, Grid, Segmented, Space, Tabs, Typography } from "antd";
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

export type StockKind = "film" | "pf" | "materials" | "fg" | "all";
export type StockTab = "items" | "lots" | "free" | "movements" | "map";

/** Остатки — единый WMS-терминал на плёнку, п/ф, материалы и изделия.
 * Вверху — быстрые кнопки ключевых складских операций (Приёмка, Сборка Pick Route,
 * Выдача, Инвентаризация).
 * Вид (плёнка / п/ф / материалы / изделия / всё) и вкладка — в адресе (?kind=&tab=). */
export default function Stock() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const wide = Grid.useBreakpoint().md ?? true;

  const has = (...perms: string[]) =>
    !!user?.is_superuser || perms.some((p) => user?.permissions.includes(p));

  const canPf = has("part_units.view", "part_units.manage", "part_storage.manage");
  const canPfLots = has("part_units.view", "part_units.manage");
  const canFilmOps = !!user?.is_superuser || !!user?.permissions.some((p) => p.startsWith("units."));
  const canBlanks = has("units.issue");

  // Права на основные складские действия
  const canReceive = has("units.receive", "materials.manage", "part_units.manage");
  const canIssue = has("units.issue", "units.return", "part_units.manage");
  const canInventory = has("inventory.manage", "part_units.count");

  const kinds: { value: StockKind; label: string }[] = [
    { value: "film", label: "Плёнка" },
    ...(canPf ? [{ value: "pf" as const, label: "П/ф" }] : []),
    { value: "materials", label: "Материалы" },
    { value: "fg", label: "Изделия" },
    ...(canPf || has("reports.view") ? [{ value: "all" as const, label: "Всё" }] : []),
  ];

  const filmState =
    !!(location.state as { globalQuery?: string; usualSupplierFilter?: string } | null)?.globalQuery ||
    !!(location.state as { usualSupplierFilter?: string } | null)?.usualSupplierFilter;

  const defaultKind: StockKind = canPf && !canFilmOps && !filmState ? "pf" : "film";
  const kindParam = params.get("kind") as StockKind | null;
  const kind: StockKind = kinds.some((k) => k.value === kindParam)
    ? (kindParam as StockKind)
    : defaultKind;

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
      { key: "lots", label: "По партиям" },
      { key: "movements", label: "Движения" },
      { key: "map", label: "Стеллажи" },
    ],
  };

  const tabs = tabsByKind[kind];
  const tabParam = params.get("tab") as StockTab | null;
  if (kind === "all" && tabParam === "items")
    return <Navigate to="/nomenclature?stock=1" replace />;
  const tab: StockTab = tabs.some((t) => t.key === tabParam)
    ? (tabParam as StockTab)
    : tabs[0].key;

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
  if (kind === "film") {
    content =
      tab === "items" || tab === "lots" ? (
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
    content =
      tab === "movements" ? (
        <MovementsPanel fixedKind="fg" defaultDays={30} />
      ) : (
        <FgStockTab />
      );
  } else if (kind === "materials") {
    content =
      tab === "movements" ? (
        <MovementsPanel fixedKind="material" defaultDays={30} />
      ) : (
        <MaterialsStockTab />
      );
  } else {
    content =
      tab === "lots" ? (
        <LotsTab />
      ) : tab === "map" ? (
        <StoragePlaces />
      ) : (
        <MovementsPanel />
      );
  }

  const kindSwitch =
    kinds.length > 1 ? (
      <Space size={8} wrap style={{ marginRight: 8, maxWidth: "100%" }}>
        <Typography.Text type="secondary" style={{ whiteSpace: "nowrap" }}>
          Вид:
        </Typography.Text>
        <Segmented
          value={kind}
          options={kinds}
          onChange={(v) =>
            go(
              v as StockKind,
              tabsByKind[v as StockKind].some((t) => t.key === tab)
                ? tab
                : tabsByKind[v as StockKind][0].key
            )
          }
        />
        {wide && <Divider type="vertical" style={{ height: 24 }} />}
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
            {canReceive && (
              <Button
                type="primary"
                size="small"
                onClick={() => navigate("/m/receive")}
              >
                📥 Приёмка
              </Button>
            )}
            {canIssue && (
              <Button
                size="small"
                onClick={() => navigate("/pick-route")}
              >
                📋 Маршрут сборки
              </Button>
            )}
            {canIssue && (
              <Button
                size="small"
                onClick={() => navigate("/m/issue")}
              >
                📤 Выдача
              </Button>
            )}
            {canInventory && (
              <Button
                size="small"
                onClick={() => navigate("/inventory")}
              >
                🔄 Инвентаризация
              </Button>
            )}
          </Space>
        </div>
      </Card>

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
