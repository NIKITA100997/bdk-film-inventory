import { useState } from "react";
import { Card, Tabs, Table, DatePicker, Space, Statistic, Row, Col, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  getStockSummary,
  getStockByWidth,
  getMovement,
  getDonorAccuracy,
  type StockSummaryLine,
  type StockByWidthLine,
  type MovementEntry,
} from "../../api/reports";

function StockSummaryTab() {
  const query = useQuery({ queryKey: ["report-stock-summary"], queryFn: getStockSummary });
  return (
    <Table<StockSummaryLine>
      rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
      loading={query.isLoading}
      dataSource={query.data ?? []}
      pagination={{ pageSize: 20 }}
      columns={[
        { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
        { title: "Остаток, м²", dataIndex: "total_area_m2" },
        { title: "Единиц", dataIndex: "unit_count" },
      ]}
    />
  );
}

function StockByWidthTab() {
  const query = useQuery({ queryKey: ["report-stock-by-width"], queryFn: getStockByWidth });
  return (
    <Table<StockByWidthLine>
      rowKey={(r) => `${r.material}-${r.color}-${r.thickness}-${r.manufacturer}-${r.width_mm}`}
      loading={query.isLoading}
      dataSource={query.data ?? []}
      pagination={{ pageSize: 20 }}
      columns={[
        { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм, ${r.manufacturer}` },
        { title: "Ширина, мм", dataIndex: "width_mm" },
        { title: "Метры", dataIndex: "total_length_m" },
        { title: "Единиц", dataIndex: "unit_count" },
      ]}
    />
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
          { title: "Когда", dataIndex: "timestamp", render: (v) => new Date(v).toLocaleString("ru-RU") },
          { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
          { title: "Событие", dataIndex: "event_type" },
          { title: "Ширина, мм", dataIndex: "width_mm" },
          { title: "Δ метры", dataIndex: "quantity_delta_m" },
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

export default function Reports() {
  return (
    <Card title="Отчёты">
      <Tabs
        items={[
          { key: "summary", label: "Остатки по материалу", children: <StockSummaryTab /> },
          { key: "width", label: "Остатки по ширине", children: <StockByWidthTab /> },
          { key: "movement", label: "Движение за период", children: <MovementTab /> },
          { key: "donor", label: <>Точность донор-рекомендаций <Tag color="blue">2.9</Tag></>, children: <DonorAccuracyTab /> },
        ]}
      />
    </Card>
  );
}
