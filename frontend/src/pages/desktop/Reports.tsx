import { useState } from "react";
import { Card, Tabs, DatePicker, Space, Row, Col, Tag, InputNumber, Select } from "antd";
import Statistic from "../../components/Statistic";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  getStockSummary,
  getStockByWidth,
  getRollsVsStrips,
  getMovement,
  getDonorAccuracy,
  getStaleUnits,
  getCuttingDiscrepancies,
  getPlanFactTasks,
  getUnitReconciliation,
  getPartUnitReconciliation,
} from "../../api/reports";
import { getStockOverview, type StockOverviewLine } from "../../api/purchasing";
import ReportTable, { type ReportColumn } from "../../components/ReportTable";
import DictAutoComplete from "../../components/DictAutoComplete";
import { listAreas } from "../../api/areas";
import { useWarehouseFilter } from "../../hooks/useWarehouseFilter";
import { useAuth } from "../../auth/AuthContext";

function StockSummaryTab() {
  const { warehouseId, picker: warehousePicker } = useWarehouseFilter();
  const [manufacturer, setManufacturer] = useState<string>();
  const query = useQuery({
    queryKey: ["report-stock-summary", warehouseId, manufacturer],
    queryFn: () => getStockSummary(warehouseId, manufacturer),
  });
  const [material, setMaterial] = useState<string>();
  const [color, setColor] = useState<string>();
  const [thickness, setThickness] = useState<number>();

  const rows = (query.data ?? []).filter(
    (r) => (!material || r.material === material) && (!color || r.color === color) && (thickness === undefined || r.thickness === thickness),
  );

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "material", header: "Материал", render: (r) => r.material, printValue: (r) => r.material, sorter: (a, b) => a.material.localeCompare(b.material) },
    { key: "color", header: "Цвет", render: (r) => r.color, printValue: (r) => r.color },
    { key: "thickness", header: "Толщина, мм", render: (r) => r.thickness, printValue: (r) => r.thickness },
    { key: "total_area_m2", header: "Остаток, м²", render: (r) => r.total_area_m2, printValue: (r) => r.total_area_m2, sorter: (a, b) => a.total_area_m2 - b.total_area_m2 },
    { key: "unit_count", header: "Единиц", render: (r) => r.unit_count, printValue: (r) => r.unit_count, sorter: (a, b) => a.unit_count - b.unit_count },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DictAutoComplete kind="materials" placeholder="Материал" value={material} onChange={(v) => setMaterial(v || undefined)} allowCreate={false} />
        <DictAutoComplete kind="colors" placeholder="Цвет" value={color} onChange={(v) => setColor(v || undefined)} allowCreate={false} />
        <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={thickness} onChange={(v) => setThickness(v ?? undefined)} />
        <DictAutoComplete kind="manufacturers" placeholder="Производитель" value={manufacturer} onChange={(v) => setManufacturer(v || undefined)} allowCreate={false} />
        {warehousePicker}
      </Space>
      <ReportTable
        title="Остатки по материалу"
        filename="ostatki-po-materialu.csv"
        rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

function StockByWidthTab() {
  const { warehouseId, picker: warehousePicker } = useWarehouseFilter();
  const [manufacturer, setManufacturer] = useState<string>();
  const query = useQuery({
    queryKey: ["report-stock-by-width", warehouseId, manufacturer],
    queryFn: () => getStockByWidth(warehouseId, manufacturer),
  });
  const [material, setMaterial] = useState<string>();
  const [color, setColor] = useState<string>();
  const [thickness, setThickness] = useState<number>();

  const rows = (query.data ?? []).filter(
    (r) =>
      (!material || r.material === material) &&
      (!color || r.color === color) &&
      (thickness === undefined || r.thickness === thickness),
  );

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "material", header: "Материал", render: (r) => r.material, printValue: (r) => r.material },
    { key: "color", header: "Цвет", render: (r) => r.color, printValue: (r) => r.color },
    { key: "thickness", header: "Толщина, мм", render: (r) => r.thickness, printValue: (r) => r.thickness },
    { key: "width_mm", header: "Ширина, мм", render: (r) => r.width_mm, printValue: (r) => r.width_mm, sorter: (a, b) => a.width_mm - b.width_mm },
    { key: "total_length_m", header: "Метры", render: (r) => r.total_length_m, printValue: (r) => r.total_length_m, sorter: (a, b) => a.total_length_m - b.total_length_m },
    { key: "unit_count", header: "Единиц", render: (r) => r.unit_count, printValue: (r) => r.unit_count, sorter: (a, b) => a.unit_count - b.unit_count },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DictAutoComplete kind="materials" placeholder="Материал" value={material} onChange={(v) => setMaterial(v || undefined)} allowCreate={false} />
        <DictAutoComplete kind="colors" placeholder="Цвет" value={color} onChange={(v) => setColor(v || undefined)} allowCreate={false} />
        <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={thickness} onChange={(v) => setThickness(v ?? undefined)} />
        <DictAutoComplete kind="manufacturers" placeholder="Производитель" value={manufacturer} onChange={(v) => setManufacturer(v || undefined)} allowCreate={false} />
        {warehousePicker}
      </Space>
      <ReportTable
        title="Остатки по ширине"
        filename="ostatki-po-shirine.csv"
        rowKey={(r) => `${r.material}-${r.color}-${r.thickness}-${r.width_mm}`}
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

function RollsVsStripsTab() {
  const { warehouseId, picker: warehousePicker } = useWarehouseFilter();
  const [manufacturer, setManufacturer] = useState<string>();
  const query = useQuery({
    queryKey: ["report-rolls-vs-strips", warehouseId, manufacturer],
    queryFn: () => getRollsVsStrips(warehouseId, manufacturer),
  });
  const [material, setMaterial] = useState<string>();
  const [color, setColor] = useState<string>();
  const [thickness, setThickness] = useState<number>();

  const rows = (query.data ?? []).filter(
    (r) =>
      (!material || r.material === material) &&
      (!color || r.color === color) &&
      (thickness === undefined || r.thickness === thickness),
  );

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "material", header: "Материал", render: (r) => r.material, printValue: (r) => r.material },
    { key: "color", header: "Цвет", render: (r) => r.color, printValue: (r) => r.color },
    { key: "thickness", header: "Толщина, мм", render: (r) => r.thickness, printValue: (r) => r.thickness },
    { key: "roll_count", header: "Рулонов, шт", render: (r) => r.roll_count, printValue: (r) => r.roll_count, sorter: (a, b) => a.roll_count - b.roll_count },
    { key: "roll_length_m", header: "Рулонов, м", render: (r) => r.roll_length_m, printValue: (r) => r.roll_length_m, sorter: (a, b) => a.roll_length_m - b.roll_length_m },
    { key: "strip_count", header: "Штрипсов, шт", render: (r) => r.strip_count, printValue: (r) => r.strip_count, sorter: (a, b) => a.strip_count - b.strip_count },
    { key: "strip_length_m", header: "Штрипсов, м", render: (r) => r.strip_length_m, printValue: (r) => r.strip_length_m, sorter: (a, b) => a.strip_length_m - b.strip_length_m },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DictAutoComplete kind="materials" placeholder="Материал" value={material} onChange={(v) => setMaterial(v || undefined)} allowCreate={false} />
        <DictAutoComplete kind="colors" placeholder="Цвет" value={color} onChange={(v) => setColor(v || undefined)} allowCreate={false} />
        <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={thickness} onChange={(v) => setThickness(v ?? undefined)} />
        <DictAutoComplete kind="manufacturers" placeholder="Производитель" value={manufacturer} onChange={(v) => setManufacturer(v || undefined)} allowCreate={false} />
        {warehousePicker}
      </Space>
      <ReportTable
        title="Рулоны и штрипсы"
        filename="rulony-i-shtripsy.csv"
        rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

function MovementTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(6, "day"), dayjs()]);
  const { warehouseId, picker: warehousePicker } = useWarehouseFilter();
  const query = useQuery({
    queryKey: ["report-movement", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), warehouseId],
    queryFn: () => getMovement(range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), undefined, warehouseId),
  });

  const rows = query.data ?? [];
  const columns: ReportColumn<(typeof rows)[number]>[] = [
    {
      key: "timestamp",
      header: "Когда",
      render: (r) => new Date(r.timestamp).toLocaleString("ru-RU"),
      printValue: (r) => new Date(r.timestamp).toLocaleString("ru-RU"),
      sorter: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      defaultSortOrder: "descend",
    },
    { key: "material", header: "Материал", render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`, printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
    { key: "event_type", header: "Событие", render: (r) => r.event_type, printValue: (r) => r.event_type },
    { key: "width_mm", header: "Ширина, мм", render: (r) => r.width_mm, printValue: (r) => r.width_mm, sorter: (a, b) => a.width_mm - b.width_mm },
    { key: "quantity_delta_m", header: "Δ метры", render: (r) => r.quantity_delta_m, printValue: (r) => r.quantity_delta_m, sorter: (a, b) => a.quantity_delta_m - b.quantity_delta_m },
    { key: "unit_id", header: "Ед.", render: (r) => r.unit_id, printValue: (r) => r.unit_id },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
        {warehousePicker}
      </Space>
      <ReportTable
        title="Движение за период"
        filename="dvizhenie.csv"
        rowKey="event_id"
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

function DonorAccuracyTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, "day"), dayjs()]);
  const query = useQuery({
    queryKey: ["report-donor-accuracy", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")],
    queryFn: () => getDonorAccuracy(range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")),
  });

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <DatePicker.RangePicker
        value={range}
        onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
      />
      {query.data && (
        <Row gutter={16}>
          <Col xs={24} sm={12} md={8}>
            <Statistic title="Предложено доноров" value={query.data.suggested} />
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Statistic title="Принято оператором" value={query.data.accepted} />
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Statistic title="Точность" value={query.data.accuracy_percent} suffix="%" />
          </Col>
        </Row>
      )}
    </Space>
  );
}

function StaleUnitsTab() {
  const query = useQuery({ queryKey: ["report-stale-units"], queryFn: () => getStaleUnits() });
  const rows = query.data ?? [];
  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "unit_id", header: "№", render: (r) => r.unit_id, printValue: (r) => r.unit_id },
    { key: "material", header: "Материал", render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм, ${r.manufacturer}`, printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм, ${r.manufacturer}` },
    { key: "size", header: "Ширина×длина", render: (r) => `${r.width_mm}×${r.length_m}`, printValue: (r) => `${r.width_mm}×${r.length_m}` },
    { key: "location_code", header: "Ячейка", render: (r) => r.location_code ?? "—", printValue: (r) => r.location_code ?? "" },
    {
      key: "days_idle",
      header: "Не двигалась, дней",
      render: (r) => <Tag color="orange">{r.days_idle}</Tag>,
      printValue: (r) => r.days_idle,
      sorter: (a, b) => a.days_idle - b.days_idle,
      defaultSortOrder: "descend",
    },
    { key: "last_moved_at", header: "Последнее движение", render: (r) => new Date(r.last_moved_at).toLocaleDateString("ru-RU"), printValue: (r) => new Date(r.last_moved_at).toLocaleDateString("ru-RU") },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        Единицы На_хранении без единого события дольше порога из настроек (Настройки → «давно не двигалась») —
        сигнал провести внеплановую ревизию адреса, а не ошибка.
      </span>
      <ReportTable
        title="Давно не двигались"
        filename="davno-ne-dvigalis.csv"
        rowKey="unit_id"
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

function CuttingDiscrepancyTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(6, "day"), dayjs()]);
  const query = useQuery({
    queryKey: ["report-cutting-discrepancies", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")],
    queryFn: () => getCuttingDiscrepancies(range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")),
  });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? areasQuery.data?.find((a) => a.code === code)?.name ?? code : "—");

  const rows = query.data ?? [];
  const columns: ReportColumn<(typeof rows)[number]>[] = [
    {
      key: "timestamp",
      header: "Когда",
      render: (r) => new Date(r.timestamp).toLocaleString("ru-RU"),
      printValue: (r) => new Date(r.timestamp).toLocaleString("ru-RU"),
      sorter: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      defaultSortOrder: "descend",
    },
    { key: "task_name", header: "Задание", render: (r) => r.task_name ?? "—", printValue: (r) => r.task_name ?? "" },
    { key: "part_name", header: "Деталь", render: (r) => r.part_name ?? "—", printValue: (r) => r.part_name ?? "" },
    { key: "area", header: "Участок", render: (r) => areaLabel(r.area), printValue: (r) => areaLabel(r.area) },
    { key: "material", header: "Плёнка", render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`, printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
    { key: "expected_length_m", header: "Ожидали, м", render: (r) => r.expected_length_m, printValue: (r) => r.expected_length_m },
    { key: "actual_length_m", header: "Ввели, м", render: (r) => r.actual_length_m, printValue: (r) => r.actual_length_m },
    {
      key: "discrepancy_m",
      header: "Отклонение, м",
      render: (r) => (
        <Tag color={r.discrepancy_m > 0 ? "green" : "red"}>
          {r.discrepancy_m > 0 ? "+" : ""}
          {r.discrepancy_m}
        </Tag>
      ),
      printValue: (r) => r.discrepancy_m,
      sorter: (a, b) => Math.abs(a.discrepancy_m) - Math.abs(b.discrepancy_m),
      defaultSortOrder: "descend",
    },
    { key: "discrepancy_percent", header: "Отклонение, %", render: (r) => `${r.discrepancy_percent}%`, printValue: (r) => r.discrepancy_percent },
    { key: "unit_id", header: "Ед.", render: (r) => r.unit_id, printValue: (r) => r.unit_id },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        Резка по плану на несколько ширин за проход (Выдача участку → «Взять в работу») — где контрольная длина,
        введённая по факту резки, заметно отличается от расчётной (донор той же длины, что и до резки).
      </span>
      <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
      <ReportTable
        title="Отклонения при резке"
        filename="otkloneniya-pri-rezke.csv"
        rowKey="event_id"
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

// Раздел про ревизию путей плёнки — рулон/штрипс, у которого выданное
// не сходится с (расход по отчётам + списано + осталось). Находит сам
// тот класс проблем, из-за которых в этой сессии вручную чинили
// штрипсы №2115/№2324/партии строки «Багет Б-2/М».
function UnitReconciliationTab() {
  const query = useQuery({ queryKey: ["report-unit-reconciliation"], queryFn: getUnitReconciliation });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? areasQuery.data?.find((a) => a.code === code)?.name ?? code : "—");

  const rows = query.data ?? [];
  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "unit_id", header: "Рулон", render: (r) => `№${r.unit_id}`, printValue: (r) => r.unit_id },
    { key: "material", header: "Плёнка", render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`, printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
    { key: "part_name", header: "Деталь", render: (r) => r.part_name ?? "—", printValue: (r) => r.part_name ?? "" },
    { key: "task_name", header: "Задание", render: (r) => r.task_name ?? "—", printValue: (r) => r.task_name ?? "" },
    { key: "area", header: "Участок", render: (r) => areaLabel(r.area), printValue: (r) => areaLabel(r.area) },
    { key: "status", header: "Статус", render: (r) => r.status, printValue: (r) => r.status },
    { key: "issued_total_m", header: "Выдано всего, м", render: (r) => r.issued_total_m, printValue: (r) => r.issued_total_m },
    { key: "consumed_calc_m", header: "Расход по отчётам, м", render: (r) => r.consumed_calc_m, printValue: (r) => r.consumed_calc_m },
    { key: "written_off_m", header: "Списано, м", render: (r) => r.written_off_m, printValue: (r) => r.written_off_m },
    { key: "current_length_m", header: "Осталось (факт), м", render: (r) => r.current_length_m ?? "—", printValue: (r) => r.current_length_m ?? "" },
    {
      key: "variance",
      header: "Расхождение, м",
      render: (r) =>
        r.over_consumed_m > 0 ? (
          <Tag color="red">перерасход +{r.over_consumed_m}</Tag>
        ) : (
          <Tag color="orange">{r.variance_m! > 0 ? "+" : ""}{r.variance_m}</Tag>
        ),
      printValue: (r) => r.over_consumed_m || r.variance_m || 0,
      sorter: (a, b) => (a.over_consumed_m || Math.abs(a.variance_m ?? 0)) - (b.over_consumed_m || Math.abs(b.variance_m ?? 0)),
      defaultSortOrder: "descend",
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        Сверка по всем рулонам/штрипсам, привязанным к заданию: выданное должно сходиться с расходом по отчётам,
        списанием и фактическим остатком. Показаны только расхождения больше допуска (5%, не меньше 0.1 м).
      </span>
      <ReportTable
        title="Сверка рулонов"
        filename="sverka-rulonov.csv"
        rowKey="unit_id"
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

// Раздел про ревизию путей п/ф — партия, у которой отчитано по FIFO
// больше, чем в ней когда-либо было (тот же класс проблемы, что баг
// "доп. рулон второй раз списывал партию п/ф", найденный и исправленный
// при этой же ревизии).
function PartUnitReconciliationTab() {
  const query = useQuery({ queryKey: ["report-part-unit-reconciliation"], queryFn: getPartUnitReconciliation });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? areasQuery.data?.find((a) => a.code === code)?.name ?? code : "—");

  const rows = query.data ?? [];
  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "unit_id", header: "Партия", render: (r) => `№${r.unit_id}`, printValue: (r) => r.unit_id },
    { key: "part_name", header: "Деталь", render: (r) => r.part_name, printValue: (r) => r.part_name },
    { key: "stage_name", header: "Этап", render: (r) => r.stage_name, printValue: (r) => r.stage_name },
    { key: "area", header: "Участок", render: (r) => areaLabel(r.area), printValue: (r) => areaLabel(r.area) },
    { key: "status", header: "Статус", render: (r) => r.status, printValue: (r) => r.status },
    { key: "quantity_pieces", header: "В партии, шт", render: (r) => r.quantity_pieces, printValue: (r) => r.quantity_pieces },
    { key: "reported_good_pieces", header: "Отчитано, шт", render: (r) => r.reported_good_pieces, printValue: (r) => r.reported_good_pieces },
    {
      key: "over_reported",
      header: "Задвоено, шт",
      render: (r) => <Tag color="red">+{r.over_reported}</Tag>,
      printValue: (r) => r.over_reported,
      sorter: (a, b) => a.over_reported - b.over_reported,
      defaultSortOrder: "descend",
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        Партии п/ф, по которым отчитано (по FIFO) больше готовых деталей, чем в них когда-либо было —
        признак задвоенного расхода.
      </span>
      <ReportTable
        title="Сверка партий п/ф"
        filename="sverka-partiy-pf.csv"
        rowKey="unit_id"
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

function PlanFactTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, "day"), dayjs()]);
  const [area, setArea] = useState<string | undefined>(undefined);
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const query = useQuery({
    queryKey: ["report-plan-fact-tasks", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), area],
    queryFn: () => getPlanFactTasks(range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), area),
  });

  const rows = query.data ?? [];
  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "created_at", header: "Создано", render: (r) => new Date(r.created_at).toLocaleDateString("ru-RU"), printValue: (r) => new Date(r.created_at).toLocaleDateString("ru-RU") },
    { key: "task_name", header: "Задание", render: (r) => r.task_name ?? `№${r.task_id}`, printValue: (r) => r.task_name ?? `№${r.task_id}` },
    { key: "area", header: "Участок", render: (r) => areaLabel(r.area), printValue: (r) => areaLabel(r.area) },
    { key: "part_name", header: "Деталь", render: (r) => r.part_name ?? "—", printValue: (r) => r.part_name ?? "" },
    { key: "material", header: "Плёнка", render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`, printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
    { key: "planned_length_m", header: "План, м", render: (r) => r.planned_length_m, printValue: (r) => r.planned_length_m },
    { key: "actual_length_m", header: "Факт, м", render: (r) => r.actual_length_m, printValue: (r) => r.actual_length_m },
    {
      key: "remaining_length_m",
      header: "Остаток, м",
      render: (r) => <Tag color={r.remaining_length_m > 0 ? "orange" : "green"}>{r.remaining_length_m}</Tag>,
      printValue: (r) => r.remaining_length_m,
      sorter: (a, b) => b.remaining_length_m - a.remaining_length_m,
      defaultSortOrder: "descend",
    },
    { key: "completion_percent", header: "Выполнено, %", render: (r) => `${r.completion_percent}%`, printValue: (r) => r.completion_percent },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        План (кол-во деталей × длина на деталь) против факта — метража, уже выданного/отрезанного складом под эту
        строку задания. Факт считается по журналу склада, а не по отчёту цеха о производстве.
      </span>
      <Space wrap>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
        <Select
          allowClear
          placeholder="Все участки"
          style={{ width: 220 }}
          value={area}
          onChange={setArea}
          options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
        />
      </Space>
      <ReportTable
        title="План/факт по заданиям"
        filename="plan-fakt-po-zadaniyam.csv"
        rowKey={(r) => `${r.line_id}`}
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

function ReorderTab() {
  const query = useQuery({ queryKey: ["report-reorder", "reorder"], queryFn: getStockOverview });
  const rows = (query.data ?? []).filter((r) => r.reorder_suggested);
  const columns: ReportColumn<StockOverviewLine>[] = [
    { key: "material", header: "Материал", render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`, printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
    { key: "total_area_m2", header: "Остаток, м²", render: (r) => r.total_area_m2, printValue: (r) => r.total_area_m2, sorter: (a, b) => a.total_area_m2 - b.total_area_m2 },
    { key: "reserved_area_m2", header: "Резерв, м²", render: (r) => r.reserved_area_m2, printValue: (r) => r.reserved_area_m2 },
    { key: "open_requested_area_m2", header: "В открытых заявках, м²", render: (r) => r.open_requested_area_m2, printValue: (r) => r.open_requested_area_m2 },
    {
      key: "days_of_stock_remaining",
      header: "Хватит дней",
      render: (r) => (r.days_of_stock_remaining === null ? "—" : <Tag color="orange">{r.days_of_stock_remaining}</Tag>),
      printValue: (r) => r.days_of_stock_remaining ?? "",
      sorter: (a, b) => (a.days_of_stock_remaining ?? Infinity) - (b.days_of_stock_remaining ?? Infinity),
      defaultSortOrder: "ascend",
    },
    { key: "usual_supplier", header: "Обычный поставщик", render: (r) => r.usual_supplier ?? "—", printValue: (r) => r.usual_supplier ?? "" },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        Позиции, по которым расход обгоняет остаток и открытые заявки поставщику — тот же сигнал, что карточка «Пора
        заказывать» на «Обзоре».
      </span>
      <ReportTable
        title="Пора заказывать"
        filename="pora-zakazyvat.csv"
        rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

export default function Reports() {
  const { user } = useAuth();
  const showReorder = !!user?.is_superuser || !!user?.permissions.includes("purchasing.manage");
  return (
    <Card title="Отчёты">
      <Tabs
        items={[
          { key: "summary", label: "Остатки по материалу", children: <StockSummaryTab /> },
          { key: "width", label: "Остатки по ширине", children: <StockByWidthTab /> },
          { key: "rolls-vs-strips", label: "Рулоны и штрипсы", children: <RollsVsStripsTab /> },
          { key: "movement", label: "Движение за период", children: <MovementTab /> },
          { key: "donor", label: <>Точность донор-рекомендаций <Tag color="blue">2.9</Tag></>, children: <DonorAccuracyTab /> },
          { key: "stale", label: "Давно не двигались", children: <StaleUnitsTab /> },
          { key: "cutting-discrepancy", label: "Отклонения при резке", children: <CuttingDiscrepancyTab /> },
          { key: "unit-reconciliation", label: "Сверка рулонов", children: <UnitReconciliationTab /> },
          { key: "part-unit-reconciliation", label: "Сверка партий п/ф", children: <PartUnitReconciliationTab /> },
          { key: "plan-fact", label: "План/факт по заданиям", children: <PlanFactTab /> },
          ...(showReorder ? [{ key: "reorder", label: "Пора заказывать", children: <ReorderTab /> }] : []),
        ]}
      />
    </Card>
  );
}
