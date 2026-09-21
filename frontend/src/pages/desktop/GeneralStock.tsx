import { useMemo, useState } from "react";
import { Card, Segmented, Input, Table, Tag, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getStockSummary } from "../../api/reports";
import { listPartUnits } from "../../api/partUnits";
import { useAuth } from "../../auth/AuthContext";

type Domain = "film" | "part";

interface GeneralRow {
  key: string;
  domain: Domain;
  label: string;
  qty: number;
  unit: string;
  onOpen: () => void;
}

/** Раздел 6 плана «Детали/П/ф остатки» — сквозной ERP-стиль справочник
 * "что и сколько у нас есть вообще", объединяющий все материальные домены
 * сразу (сейчас плёнка + п/ф, дальше — готовая продукция и материалы).
 * Намеренно НЕ заменяет собой ни «Остатки плёнки»/«Стеллажи и полки», ни
 * «Остатки и стеллажи п/ф» — те остаются рабочими экранами со своими
 * действиями (приёмка/списание/размещение) для кладовщиков/мастеров;
 * этот экран — read-only сводка для планирования, клик по строке ведёт
 * на карточку материала/детали. /stock не трогаем — там завязаны глобальный
 * поиск из шапки (unitSearch.ts), мобильная вкладка и переходы из
 * "Закупок"/"Обзора", менять его смысл слишком рискованно для живого
 * ежедневного экрана кладовщика. */
export default function GeneralStock() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canViewParts =
    !!user?.is_superuser || !!user?.permissions.includes("part_units.view") || !!user?.permissions.includes("part_units.manage");

  const [domainFilter, setDomainFilter] = useState<"all" | Domain>("all");
  const [search, setSearch] = useState("");

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

  const filmRows: GeneralRow[] = useMemo(
    () =>
      (filmQuery.data ?? []).map((r) => ({
        key: `film-${r.material}-${r.color}-${r.thickness}`,
        domain: "film" as const,
        label: `${r.material}, ${r.color}, ${r.thickness} мм`,
        qty: r.total_area_m2,
        unit: "м²",
        onOpen: () => navigate("/materials", { state: { material: r.material, color: r.color, thickness: r.thickness } }),
      })),
    [filmQuery.data, navigate],
  );

  const partRows: GeneralRow[] = useMemo(() => {
    if (!canViewParts) return [];
    const byPart = new Map<number, { name: string; qty: number }>();
    for (const u of partUnitsQuery.data ?? []) {
      if (u.status === "Списан") continue;
      const g = byPart.get(u.part_id) ?? { name: u.part_name, qty: 0 };
      g.qty += u.quantity_available;
      byPart.set(u.part_id, g);
    }
    return [...byPart.entries()]
      .filter(([, g]) => g.qty > 0)
      .map(([partId, g]) => ({
        key: `part-${partId}`,
        domain: "part" as const,
        label: g.name,
        qty: g.qty,
        unit: "шт",
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
    return true;
  });

  const domainOptions = [
    { label: "Все", value: "all" },
    { label: "🎞 Плёнка", value: "film" },
    ...(canViewParts ? [{ label: "🔩 П/ф", value: "part" }] : []),
  ];

  return (
    <Card title="Общие остатки — справочник">
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
      </Space>
      <Table<GeneralRow>
        size="small"
        rowKey="key"
        loading={filmQuery.isLoading || (canViewParts && partUnitsQuery.isLoading)}
        dataSource={filtered}
        pagination={{ pageSize: 30 }}
        onRow={(r) => ({ onClick: r.onOpen, style: { cursor: "pointer" } })}
        columns={[
          {
            title: "Домен",
            width: 100,
            render: (_, r) => <Tag color={r.domain === "film" ? "geekblue" : "green"}>{r.domain === "film" ? "Плёнка" : "П/ф"}</Tag>,
          },
          { title: "Позиция", dataIndex: "label" },
          { title: "Остаток", render: (_, r) => `${Math.round(r.qty * 100) / 100} ${r.unit}` },
        ]}
      />
    </Card>
  );
}
