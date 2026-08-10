import { useMemo, useState } from "react";
import { Card, Radio, Switch, Button, Space, Select, InputNumber, Table, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { searchUnits, skuLabel, type MaterialUnit, type SearchParams, type UnitStatusValue } from "../../api/units";
import { getStockSummary, type StockSummaryLine } from "../../api/reports";
import { listAbcClasses, recomputeAbc } from "../../api/abc";
import DictAutoComplete from "../../components/DictAutoComplete";
import { useAuth } from "../../auth/AuthContext";

const statusOptions: { value: UnitStatusValue; label: string }[] = [
  { value: "Принят", label: "Принят" },
  { value: "На_хранении", label: "На хранении" },
  { value: "Выдан_участку", label: "Выдан участку" },
  { value: "Списан", label: "Списан" },
];

const areaLabels: Record<string, string> = {
  okutka_tsargovykh: "Окутка царговых",
  shchitovye_dveri: "Щитовые двери",
  tselnolistovye_dveri: "Цельнолистовые двери",
};
const areaOptions = Object.entries(areaLabels).map(([value, label]) => ({ value, label }));

export default function MaterialsExplorer() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canManageAbc = user?.role === "logist" || user?.role === "admin";

  const [viewMode, setViewMode] = useState<"positions" | "units">("positions");
  const [donorOnly, setDonorOnly] = useState(false);
  const [filters, setFilters] = useState<SearchParams>({});

  const positionsQuery = useQuery({ queryKey: ["materials-explorer", "positions"], queryFn: getStockSummary, enabled: viewMode === "positions" });
  const unitsQuery = useQuery({
    queryKey: ["materials-explorer", "units", filters],
    queryFn: () => searchUnits(filters),
    enabled: viewMode === "units",
  });
  const classesQuery = useQuery({ queryKey: ["abc-classes", "all"], queryFn: () => listAbcClasses() });

  const recomputeMutation = useMutation({
    mutationFn: () => recomputeAbc(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["abc-classes"] });
      message.success(`Пересчитано позиций: ${r.updated} (период ${r.period_days} дн.)`);
    },
    onError: () => message.error("Не удалось пересчитать"),
  });

  const classCKeys = useMemo(() => {
    const set = new Set<string>();
    for (const c of classesQuery.data ?? []) {
      if (c.width_class === "C") set.add(`${c.material}|${c.color}|${c.thickness}|${c.width_mm}`);
    }
    return set;
  }, [classesQuery.data]);

  const lastRecomputed = useMemo(() => {
    const dates = (classesQuery.data ?? []).map((c) => c.computed_at);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [classesQuery.data]);

  const setFilter = <K extends keyof SearchParams>(key: K, value: SearchParams[K] | undefined) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const filteredPositions = (positionsQuery.data ?? []).filter((p) => {
    if (filters.material && p.material !== filters.material) return false;
    if (filters.color && p.color !== filters.color) return false;
    if (filters.thickness !== undefined && p.thickness !== filters.thickness) return false;
    return true;
  });

  const displayedUnits = (unitsQuery.data ?? []).filter((u) => {
    if (!donorOnly) return true;
    const key = `${u.material_sku.material.name}|${u.material_sku.color.name}|${u.material_sku.thickness.value_mm}|${u.width_mm}`;
    return u.status === "На_хранении" && classCKeys.has(key);
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Материалы">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Radio.Group value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
              <Radio.Button value="positions">По позициям материала</Radio.Button>
              <Radio.Button value="units">По физическим единицам</Radio.Button>
            </Radio.Group>
            {canManageAbc && (
              <Button onClick={() => recomputeMutation.mutate()} loading={recomputeMutation.isPending}>
                Пересчитать ABC
              </Button>
            )}
            {lastRecomputed && (
              <Typography.Text type="secondary">
                Классы пересчитаны: {new Date(lastRecomputed).toLocaleString("ru-RU")}
              </Typography.Text>
            )}
          </Space>

          <Space wrap>
            <DictAutoComplete kind="materials" placeholder="Материал" value={filters.material} onChange={(v) => setFilter("material", v || undefined)} />
            <DictAutoComplete kind="colors" placeholder="Цвет" value={filters.color} onChange={(v) => setFilter("color", v || undefined)} />
            <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={filters.thickness} onChange={(v) => setFilter("thickness", v ?? undefined)} />
            {viewMode === "units" && (
              <>
                <DictAutoComplete kind="manufacturers" placeholder="Производитель" value={filters.manufacturer} onChange={(v) => setFilter("manufacturer", v || undefined)} />
                <InputNumber placeholder="Ширина, мм" min={1} value={filters.width_mm} onChange={(v) => setFilter("width_mm", v ?? undefined)} />
                <InputNumber placeholder="Мин. длина, м" min={0} step={0.1} value={filters.min_length_m} onChange={(v) => setFilter("min_length_m", v ?? undefined)} />
                <Select placeholder="Статус" allowClear style={{ width: 160 }} options={statusOptions} value={filters.status} onChange={(v) => setFilter("status", v)} />
                <Select placeholder="Участок" allowClear style={{ width: 180 }} options={areaOptions} value={filters.area} onChange={(v) => setFilter("area", v)} />
                <Space size={4}>
                  <Switch checked={donorOnly} onChange={setDonorOnly} />
                  <Typography.Text>класс C, есть донор-кандидат</Typography.Text>
                </Space>
              </>
            )}
          </Space>
        </Space>
      </Card>

      {viewMode === "positions" ? (
        <Card>
          <Table<StockSummaryLine>
            rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
            loading={positionsQuery.isLoading}
            dataSource={filteredPositions}
            pagination={{ pageSize: 20 }}
            onRow={(r) => ({
              onClick: () =>
                navigate("/materials", { state: { material: r.material, color: r.color, thickness: r.thickness } }),
            })}
            columns={[
              { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
              { title: "Остаток, м²", dataIndex: "total_area_m2" },
              { title: "Единиц", dataIndex: "unit_count" },
            ]}
          />
        </Card>
      ) : (
        <Card>
          <Table<MaterialUnit>
            rowKey="id"
            loading={unitsQuery.isLoading}
            dataSource={displayedUnits}
            pagination={{ pageSize: 20 }}
            onRow={(u) => ({ onClick: () => navigate("/m/unit-card", { state: { unitId: u.id } }) })}
            columns={[
              { title: "ID", dataIndex: "id" },
              { title: "Материал", render: (_, u) => skuLabel(u.material_sku) },
              { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
              { title: "Статус", render: (_, u) => u.status.replace(/_/g, " ") },
              { title: "Адрес/участок", render: (_, u) => u.location_code ?? (u.area ? areaLabels[u.area] : null) ?? "—" },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}
