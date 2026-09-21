import { useMemo, useState } from "react";
import { Card, Segmented, Input, Tag, Space, Typography, Checkbox, Select, Button } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import ResponsiveTable from "../../components/ResponsiveTable";
import { getStockSummary } from "../../api/reports";
import { listPartUnits } from "../../api/partUnits";
import { listAreas } from "../../api/areas";
import { useAuth } from "../../auth/AuthContext";
import { exportToCsv } from "../../utils/csv";

type Domain = "film" | "part";

interface GeneralRow {
  key: string;
  domain: Domain;
  domainLabel: string;
  label: string;
  qty: number;
  unit: string;
  // Раздел про фильтр по участку — только у п/ф (плёнка в getStockSummary
  // не несёт участок, это сводка по SKU целиком, без разбивки по месту).
  // Пусто у плёночных строк — под фильтром они не пропадают: фильтровать
  // просто нечем, честнее показать, чем спрятать.
  areas: string[];
  onOpen: () => void;
}

/** Раздел 6 плана «Детали/П/ф остатки» — сквозной ERP-стиль справочник
 * "что и сколько у нас есть вообще", объединяющий все материальные домены
 * сразу (сейчас плёнка + п/ф, дальше — готовая продукция и материалы).
 * Намеренно НЕ заменяет собой ни «Остатки плёнки»/«Стеллажи и полки», ни
 * «Остатки и стеллажи п/ф» — те остаются рабочими экранами со своими
 * действиями (приёмка/списание/размещение) для кладовщиков/мастеров;
 * этот экран — сводка для планирования (клик по строке ведёт на карточку
 * материала/детали), но с полным набором работы со списком (фильтры,
 * выгрузка, настройка столбцов, выбор строк), а не голая таблица — раздел
 * про наполнение этого экрана функциями после первой версии.
 *
 * /stock не трогаем и не переиспользуем под общий вид — на нём завязаны
 * глобальный поиск из шапки (unitSearch.ts), мобильная вкладка и переходы
 * из "Закупок"/"Обзора": живой ежедневный экран кладовщика. */
export default function GeneralStock() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canViewParts =
    !!user?.is_superuser || !!user?.permissions.includes("part_units.view") || !!user?.permissions.includes("part_units.manage");

  const [domainFilter, setDomainFilter] = useState<"all" | Domain>("all");
  const [search, setSearch] = useState("");
  const [areaFilter, setAreaFilter] = useState<string | undefined>(undefined);
  const [showZero, setShowZero] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);

  const filmQuery = useQuery({ queryKey: ["general-stock", "film"], queryFn: () => getStockSummary() });
  // listPartUnits требует part_units.view/manage (в отличие от stock-summary,
  // открытого любому аутентифицированному) — без права просто не запрашиваем,
  // иначе получили бы 403 от чужого эндпоинта (тот же приём, что
  // canViewPurchasing в MaterialsExplorer.tsx).
  const partUnitsQuery = useQuery({
    queryKey: ["general-stock", "parts"],
    queryFn: () => listPartUnits(),
    enabled: canViewParts,
  });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));

  const filmRows: GeneralRow[] = useMemo(
    () =>
      (filmQuery.data ?? []).map((r) => ({
        key: `film-${r.material}-${r.color}-${r.thickness}`,
        domain: "film" as const,
        domainLabel: "Плёнка",
        label: `${r.material}, ${r.color}, ${r.thickness} мм`,
        qty: r.total_area_m2,
        unit: "м²",
        areas: [],
        onOpen: () => navigate("/materials", { state: { material: r.material, color: r.color, thickness: r.thickness } }),
      })),
    [filmQuery.data, navigate],
  );

  const partRows: GeneralRow[] = useMemo(() => {
    if (!canViewParts) return [];
    const byPart = new Map<number, { name: string; qty: number; areas: Set<string> }>();
    for (const u of partUnitsQuery.data ?? []) {
      if (u.status === "Списан") continue;
      const g = byPart.get(u.part_id) ?? { name: u.part_name, qty: 0, areas: new Set<string>() };
      g.qty += u.quantity_available;
      if (u.area && u.quantity_available > 0) g.areas.add(u.area);
      byPart.set(u.part_id, g);
    }
    return [...byPart.entries()].map(([partId, g]) => ({
      key: `part-${partId}`,
      domain: "part" as const,
      domainLabel: "П/ф",
      label: g.name,
      qty: g.qty,
      unit: "шт",
      areas: [...g.areas],
      onOpen: () => navigate("/part-card", { state: { partId } }),
    }));
  }, [partUnitsQuery.data, canViewParts, navigate]);

  const allRows = useMemo(
    () => [...filmRows, ...partRows].sort((a, b) => a.label.localeCompare(b.label, "ru")),
    [filmRows, partRows],
  );

  const filtered = allRows.filter((r) => {
    if (domainFilter !== "all" && r.domain !== domainFilter) return false;
    if (search.trim() && !r.label.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (areaFilter && r.areas.length > 0 && !r.areas.includes(areaFilter)) return false;
    if (!showZero && r.qty <= 0) return false;
    return true;
  });

  const domainOptions = [
    { label: "Все", value: "all" },
    { label: "🎞 Плёнка", value: "film" },
    ...(canViewParts ? [{ label: "🔩 П/ф", value: "part" }] : []),
  ];

  const exportRows = (rows: GeneralRow[]) =>
    exportToCsv(
      "obshchie-ostatki.csv",
      rows.map((r) => ({ domainLabel: r.domainLabel, label: r.label, qty: Math.round(r.qty * 100) / 100, unit: r.unit })),
      [
        { key: "domainLabel", header: "Домен" },
        { key: "label", header: "Позиция" },
        { key: "qty", header: "Остаток" },
        { key: "unit", header: "Ед." },
      ],
    );

  const selectedRows = filtered.filter((r) => selectedKeys.includes(r.key));

  return (
    <Card
      title="Общие остатки — справочник"
      extra={
        <Space wrap>
          {selectedKeys.length > 0 && (
            <Button size="small" onClick={() => exportRows(selectedRows)}>
              Выгрузить выбранное ({selectedKeys.length})
            </Button>
          )}
          <Button size="small" onClick={() => exportRows(filtered)}>
            Экспорт в Excel
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        Сквозная справка «что и сколько у нас есть вообще» по всем доменам сразу — для повседневной работы
        (приёмка/списание/размещение) используйте «Остатки плёнки»/«Стеллажи и полки» и «Остатки и стеллажи п/ф»,
        здесь те же остатки, просто в одном месте для планирования по расходу.
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented options={domainOptions} value={domainFilter} onChange={(v) => setDomainFilter(v as "all" | Domain)} />
        <Input.Search
          allowClear
          placeholder="Поиск по позиции…"
          style={{ width: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {canViewParts && (
          <Select
            allowClear
            placeholder="Участок (только п/ф)"
            style={{ width: 220 }}
            options={areaOptions}
            value={areaFilter}
            onChange={setAreaFilter}
          />
        )}
        <Checkbox checked={showZero} onChange={(e) => setShowZero(e.target.checked)}>
          Показывать нулевые остатки
        </Checkbox>
      </Space>
      <ResponsiveTable<GeneralRow>
        tableKey="general-stock"
        lockedColumns={["Домен", "Позиция"]}
        size="small"
        rowKey="key"
        loading={filmQuery.isLoading || (canViewParts && partUnitsQuery.isLoading)}
        dataSource={filtered}
        pagination={{ pageSize: 30 }}
        rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
        onRow={(r) => ({ onClick: () => r.onOpen(), style: { cursor: "pointer" } })}
        columns={[
          {
            title: "Домен",
            width: 100,
            render: (_, r) => <Tag color={r.domain === "film" ? "geekblue" : "green"}>{r.domainLabel}</Tag>,
          },
          { title: "Позиция", dataIndex: "label" },
          { title: "Остаток", render: (_, r) => `${Math.round(r.qty * 100) / 100} ${r.unit}` },
          {
            title: "Участок",
            render: (_, r) => (r.areas.length > 0 ? r.areas.map((a) => <Tag key={a}>{areaLabel(a)}</Tag>) : "—"),
          },
        ]}
      />
    </Card>
  );
}
