import { useMemo, useState } from "react";
import { Card, Segmented, Input, Tag, Space, Typography, Checkbox, Select, Button } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import ResponsiveTable from "../../components/ResponsiveTable";
import { getStockSummary, getRollsVsStrips } from "../../api/reports";
import { listPartUnits } from "../../api/partUnits";
import { listAreas } from "../../api/areas";
import { useAuth } from "../../auth/AuthContext";
import { exportToExcel } from "../../utils/excel";

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
  // Единиц (плёнка — сколько физических рулонов/штрипсов всего) или
  // партий (п/ф — сколько отдельных партий составляют этот остаток) —
  // тот же смысл ("сколько отдельных физических кусков"), разные слова.
  unitCount: number;
  // Разбивка рулон/штрипс — только у плёнки (раздел про недостающие
  // столбцы: раньше эту разбивку было видно только в "Остатках плёнки"/
  // карточке материала/отчёте "Рулоны и штрипсы", здесь её не было вовсе).
  rollCount?: number;
  rollLengthM?: number;
  stripCount?: number;
  stripLengthM?: number;
  // По этапам — только у п/ф (раздел про недостающие столбцы, тот же
  // смысл, что уже показывает "Остатки п/ф").
  byStage?: { stageName: string; qty: number }[];
  onOpen: () => void;
}

/** Раздел 6 плана «Детали/П/ф остатки» — сквозной ERP-стиль справочник
 * "что и сколько у нас есть вообще", объединяющий все материальные домены
 * сразу (сейчас плёнка + п/ф, дальше — готовая продукция и материалы).
 * Намеренно НЕ заменяет собой ни «Остатки плёнки», ни «Остатки и стеллажи
 * п/ф» — те остаются рабочими экранами со своими действиями (приёмка/
 * списание/размещение) для кладовщиков/мастеров; этот экран — сводка для
 * планирования (клик по строке ведёт на карточку материала/детали), но с
 * той же глубиной данных, что и там (рулоны/штрипсы, разбивка по этапам/
 * участкам), плюс полноценная работа со списком (фильтры, выгрузка,
 * настройка столбцов, выбор строк) — раздел про наполнение этого экрана
 * функциями после первой версии.
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
  const rollsVsStripsQuery = useQuery({ queryKey: ["general-stock", "rolls-vs-strips"], queryFn: () => getRollsVsStrips() });
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

  const rollsVsStripsByKey = useMemo(() => {
    const map = new Map<string, { rollCount: number; rollLengthM: number; stripCount: number; stripLengthM: number }>();
    for (const r of rollsVsStripsQuery.data ?? []) {
      map.set(`${r.material}|${r.color}|${r.thickness}`, {
        rollCount: r.roll_count,
        rollLengthM: r.roll_length_m,
        stripCount: r.strip_count,
        stripLengthM: r.strip_length_m,
      });
    }
    return map;
  }, [rollsVsStripsQuery.data]);

  const filmRows: GeneralRow[] = useMemo(
    () =>
      (filmQuery.data ?? []).map((r) => {
        const rvs = rollsVsStripsByKey.get(`${r.material}|${r.color}|${r.thickness}`);
        return {
          key: `film-${r.material}-${r.color}-${r.thickness}`,
          domain: "film" as const,
          domainLabel: "Плёнка",
          label: `${r.material}, ${r.color}, ${r.thickness} мм`,
          qty: r.total_area_m2,
          unit: "м²",
          areas: [],
          unitCount: r.unit_count,
          rollCount: rvs?.rollCount ?? 0,
          rollLengthM: rvs?.rollLengthM ?? 0,
          stripCount: rvs?.stripCount ?? 0,
          stripLengthM: rvs?.stripLengthM ?? 0,
          onOpen: () => navigate("/materials", { state: { material: r.material, color: r.color, thickness: r.thickness } }),
        };
      }),
    [filmQuery.data, rollsVsStripsByKey, navigate],
  );

  const partRows: GeneralRow[] = useMemo(() => {
    if (!canViewParts) return [];
    const byPart = new Map<
      number,
      { name: string; qty: number; areas: Set<string>; unitCount: number; stageQty: Map<string, number> }
    >();
    for (const u of partUnitsQuery.data ?? []) {
      if (u.status === "Списан") continue;
      const g = byPart.get(u.part_id) ?? { name: u.part_name, qty: 0, areas: new Set<string>(), unitCount: 0, stageQty: new Map() };
      g.qty += u.quantity_available;
      if (u.quantity_available > 0) {
        g.unitCount += 1;
        g.stageQty.set(u.stage_name, (g.stageQty.get(u.stage_name) ?? 0) + u.quantity_available);
        if (u.area) g.areas.add(u.area);
      }
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
      unitCount: g.unitCount,
      byStage: [...g.stageQty.entries()].map(([stageName, qty]) => ({ stageName, qty })),
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
    exportToExcel(
      "obshchie-ostatki.xlsx",
      rows.map((r) => ({
        domainLabel: r.domainLabel,
        label: r.label,
        qty: Math.round(r.qty * 100) / 100,
        unit: r.unit,
        unitCount: r.unitCount,
        rollCount: r.rollCount ?? "",
        rollLengthM: r.rollLengthM ?? "",
        stripCount: r.stripCount ?? "",
        stripLengthM: r.stripLengthM ?? "",
        stages: (r.byStage ?? []).map((s) => `${s.stageName}: ${Math.round(s.qty * 100) / 100}`).join(", "),
        areas: r.areas.map(areaLabel).join(", "),
      })),
      [
        { key: "domainLabel", header: "Домен" },
        { key: "label", header: "Позиция" },
        { key: "qty", header: "Остаток" },
        { key: "unit", header: "Ед." },
        { key: "unitCount", header: "Единиц/партий" },
        { key: "rollCount", header: "Рулонов, шт" },
        { key: "rollLengthM", header: "Рулонов, м" },
        { key: "stripCount", header: "Штрипсов, шт" },
        { key: "stripLengthM", header: "Штрипсов, м" },
        { key: "stages", header: "По этапам (п/ф)" },
        { key: "areas", header: "Участок (п/ф)" },
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
        (приёмка/списание/размещение) используйте «Остатки плёнки» и «Остатки и стеллажи п/ф», здесь те же остатки,
        с той же глубиной данных, просто в одном месте для планирования по расходу.
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
        loading={filmQuery.isLoading || rollsVsStripsQuery.isLoading || (canViewParts && partUnitsQuery.isLoading)}
        dataSource={filtered}
        pagination={{ pageSize: 30 }}
        scroll={{ x: "max-content" }}
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
          { title: "Единиц/партий", width: 110, render: (_, r) => r.unitCount },
          {
            title: "Рулонов",
            render: (_, r) => (r.domain === "film" ? `${r.rollCount} шт · ${Math.round((r.rollLengthM ?? 0) * 10) / 10} м` : "—"),
          },
          {
            title: "Штрипсов",
            render: (_, r) => (r.domain === "film" ? `${r.stripCount} шт · ${Math.round((r.stripLengthM ?? 0) * 10) / 10} м` : "—"),
          },
          {
            title: "По этапам",
            render: (_, r) =>
              r.byStage && r.byStage.length > 0 ? (
                <Space size={4} wrap>
                  {r.byStage.map((s) => (
                    <Tag key={s.stageName} style={{ margin: 0 }}>
                      {s.stageName}: {Math.round(s.qty * 100) / 100}
                    </Tag>
                  ))}
                </Space>
              ) : (
                "—"
              ),
          },
          {
            title: "Участок",
            render: (_, r) => (r.areas.length > 0 ? r.areas.map((a) => <Tag key={a}>{areaLabel(a)}</Tag>) : "—"),
          },
        ]}
      />
    </Card>
  );
}
