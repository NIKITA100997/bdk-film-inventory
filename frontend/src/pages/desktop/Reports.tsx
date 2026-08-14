import { useState } from "react";
import { Card, Tabs, DatePicker, Space, Statistic, Row, Col, Tag, InputNumber } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  getStockSummary,
  getStockByWidth,
  getMovement,
  getDonorAccuracy,
  getStaleUnits,
} from "../../api/reports";
import { getOrdersReport } from "../../api/orders";
import ReportTable, { type ReportColumn } from "../../components/ReportTable";
import DictAutoComplete from "../../components/DictAutoComplete";

function StockSummaryTab() {
  const query = useQuery({ queryKey: ["report-stock-summary"], queryFn: getStockSummary });
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
        <DictAutoComplete kind="materials" placeholder="Материал" value={material} onChange={(v) => setMaterial(v || undefined)} />
        <DictAutoComplete kind="colors" placeholder="Цвет" value={color} onChange={(v) => setColor(v || undefined)} />
        <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={thickness} onChange={(v) => setThickness(v ?? undefined)} />
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
  const query = useQuery({ queryKey: ["report-stock-by-width"], queryFn: getStockByWidth });
  const [material, setMaterial] = useState<string>();
  const [color, setColor] = useState<string>();
  const [thickness, setThickness] = useState<number>();

  const rows = (query.data ?? []).filter(
    (r) => (!material || r.material === material) && (!color || r.color === color) && (thickness === undefined || r.thickness === thickness),
  );

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "material", header: "Материал", render: (r) => r.material, printValue: (r) => r.material },
    { key: "color", header: "Цвет", render: (r) => r.color, printValue: (r) => r.color },
    { key: "thickness", header: "Толщина, мм", render: (r) => r.thickness, printValue: (r) => r.thickness },
    { key: "manufacturer", header: "Производитель", render: (r) => r.manufacturer, printValue: (r) => r.manufacturer },
    { key: "width_mm", header: "Ширина, мм", render: (r) => r.width_mm, printValue: (r) => r.width_mm, sorter: (a, b) => a.width_mm - b.width_mm },
    { key: "total_length_m", header: "Метры", render: (r) => r.total_length_m, printValue: (r) => r.total_length_m, sorter: (a, b) => a.total_length_m - b.total_length_m },
    { key: "unit_count", header: "Единиц", render: (r) => r.unit_count, printValue: (r) => r.unit_count, sorter: (a, b) => a.unit_count - b.unit_count },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DictAutoComplete kind="materials" placeholder="Материал" value={material} onChange={(v) => setMaterial(v || undefined)} />
        <DictAutoComplete kind="colors" placeholder="Цвет" value={color} onChange={(v) => setColor(v || undefined)} />
        <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={thickness} onChange={(v) => setThickness(v ?? undefined)} />
      </Space>
      <ReportTable
        title="Остатки по ширине"
        filename="ostatki-po-shirine.csv"
        rowKey={(r) => `${r.material}-${r.color}-${r.thickness}-${r.manufacturer}-${r.width_mm}`}
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

function MovementTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(6, "day"), dayjs()]);
  const query = useQuery({
    queryKey: ["report-movement", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")],
    queryFn: () => getMovement(range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")),
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
      <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
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

function OrdersReportTab() {
  const query = useQuery({ queryKey: ["report-orders"], queryFn: getOrdersReport });
  const rows = query.data ?? [];
  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "number", header: "Номер", render: (r) => r.number, printValue: (r) => r.number },
    {
      key: "status",
      header: "Статус",
      render: (r) => (r.status === "closed" ? <Tag>Закрыт</Tag> : <Tag color="green">Открыт</Tag>),
      printValue: (r) => (r.status === "closed" ? "Закрыт" : "Открыт"),
    },
    { key: "planned_area_m2", header: "План, м²", render: (r) => r.planned_area_m2, printValue: (r) => r.planned_area_m2, sorter: (a, b) => a.planned_area_m2 - b.planned_area_m2 },
    { key: "actual_area_m2", header: "Факт, м²", render: (r) => r.actual_area_m2, printValue: (r) => r.actual_area_m2, sorter: (a, b) => a.actual_area_m2 - b.actual_area_m2 },
    { key: "percent_complete", header: "% выполнения", render: (r) => `${r.percent_complete}%`, printValue: (r) => r.percent_complete, sorter: (a, b) => a.percent_complete - b.percent_complete },
    {
      key: "created_at",
      header: "Создан",
      render: (r) => new Date(r.created_at).toLocaleDateString("ru-RU"),
      printValue: (r) => new Date(r.created_at).toLocaleDateString("ru-RU"),
      sorter: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      defaultSortOrder: "descend",
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        Сводка по всем заказам (4 раздел обратной связи) — план/факт по каждому заказу считается отдельно на
        экране «Заказы», здесь только общая картина.
      </span>
      <ReportTable
        title="По заказам"
        filename="po-zakazam.csv"
        rowKey="id"
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

export default function Reports() {
  return (
    <Card title="Отчёты">
      <Tabs
        items={[
          { key: "summary", label: "Остатки по материалу", children: <StockSummaryTab /> },
          { key: "width", label: "Остатки по ширине", children: <StockByWidthTab /> },
          { key: "movement", label: "Движение за период", children: <MovementTab /> },
          { key: "donor", label: <>Точность донор-рекомендаций <Tag color="blue">2.9</Tag></>, children: <DonorAccuracyTab /> },
          { key: "stale", label: "Давно не двигались", children: <StaleUnitsTab /> },
          { key: "orders", label: "По заказам", children: <OrdersReportTab /> },
        ]}
      />
    </Card>
  );
}
