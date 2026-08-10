import { useState } from "react";
import { Card, Tabs, Table, DatePicker, Space, Statistic, Row, Col, Tag, Button } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  getStockSummary,
  getStockByWidth,
  getMovement,
  getDonorAccuracy,
  getStaleUnits,
  type StockSummaryLine,
  type StockByWidthLine,
  type MovementEntry,
  type StaleUnitLine,
} from "../../api/reports";
import { exportToCsv } from "../../utils/csv";

function StockSummaryTab() {
  const query = useQuery({ queryKey: ["report-stock-summary"], queryFn: getStockSummary });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button
        onClick={() =>
          exportToCsv("ostatki-po-materialu.csv", query.data ?? [], [
            { key: "material", header: "Материал" },
            { key: "color", header: "Цвет" },
            { key: "thickness", header: "Толщина, мм" },
            { key: "total_area_m2", header: "Остаток, м²" },
            { key: "unit_count", header: "Единиц" },
          ])
        }
      >
        Экспорт в Excel
      </Button>
      <Table<StockSummaryLine>
        rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
        loading={query.isLoading}
        dataSource={query.data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм`, sorter: (a, b) => a.material.localeCompare(b.material) },
          { title: "Остаток, м²", dataIndex: "total_area_m2", sorter: (a, b) => a.total_area_m2 - b.total_area_m2 },
          { title: "Единиц", dataIndex: "unit_count", sorter: (a, b) => a.unit_count - b.unit_count },
        ]}
      />
    </Space>
  );
}

function StockByWidthTab() {
  const query = useQuery({ queryKey: ["report-stock-by-width"], queryFn: getStockByWidth });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button
        onClick={() =>
          exportToCsv("ostatki-po-shirine.csv", query.data ?? [], [
            { key: "material", header: "Материал" },
            { key: "color", header: "Цвет" },
            { key: "thickness", header: "Толщина, мм" },
            { key: "manufacturer", header: "Производитель" },
            { key: "width_mm", header: "Ширина, мм" },
            { key: "total_length_m", header: "Метры" },
            { key: "unit_count", header: "Единиц" },
          ])
        }
      >
        Экспорт в Excel
      </Button>
      <Table<StockByWidthLine>
        rowKey={(r) => `${r.material}-${r.color}-${r.thickness}-${r.manufacturer}-${r.width_mm}`}
        loading={query.isLoading}
        dataSource={query.data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм, ${r.manufacturer}` },
          { title: "Ширина, мм", dataIndex: "width_mm", sorter: (a, b) => a.width_mm - b.width_mm },
          { title: "Метры", dataIndex: "total_length_m", sorter: (a, b) => a.total_length_m - b.total_length_m },
          { title: "Единиц", dataIndex: "unit_count", sorter: (a, b) => a.unit_count - b.unit_count },
        ]}
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

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <DatePicker.RangePicker
        value={range}
        onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
      />
      <Table<MovementEntry>
        rowKey="event_id"
        loading={query.isLoading}
        dataSource={query.data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: "Когда",
            dataIndex: "timestamp",
            render: (v) => new Date(v).toLocaleString("ru-RU"),
            sorter: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            defaultSortOrder: "descend",
          },
          { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
          { title: "Событие", dataIndex: "event_type" },
          { title: "Ширина, мм", dataIndex: "width_mm", sorter: (a, b) => a.width_mm - b.width_mm },
          { title: "Δ метры", dataIndex: "quantity_delta_m", sorter: (a, b) => a.quantity_delta_m - b.quantity_delta_m },
          { title: "Ед.", dataIndex: "unit_id" },
        ]}
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
          <Col span={6}>
            <Statistic title="Предложено доноров" value={query.data.suggested} />
          </Col>
          <Col span={6}>
            <Statistic title="Принято оператором" value={query.data.accepted} />
          </Col>
          <Col span={6}>
            <Statistic title="Точность" value={query.data.accuracy_percent} suffix="%" />
          </Col>
        </Row>
      )}
    </Space>
  );
}

function StaleUnitsTab() {
  const query = useQuery({ queryKey: ["report-stale-units"], queryFn: () => getStaleUnits() });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        Единицы На_хранении без единого события дольше порога из настроек (Настройки → «давно не двигалась») —
        сигнал провести внеплановую ревизию адреса, а не ошибка.
      </span>
      <Table<StaleUnitLine>
        rowKey="unit_id"
        loading={query.isLoading}
        dataSource={query.data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "№", dataIndex: "unit_id" },
          { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм, ${r.manufacturer}` },
          { title: "Ширина×длина", render: (_, r) => `${r.width_mm}×${r.length_m}` },
          { title: "Ячейка", dataIndex: "location_code", render: (v: string | null) => v ?? "—" },
          { title: "Не двигалась, дней", dataIndex: "days_idle", render: (v: number) => <Tag color="orange">{v}</Tag> },
          { title: "Последнее движение", dataIndex: "last_moved_at", render: (v: string) => new Date(v).toLocaleDateString("ru-RU") },
        ]}
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
        ]}
      />
    </Card>
  );
}
