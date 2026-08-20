import { useState } from "react";
import { Card, Tabs, DatePicker, Space, Row, Col, Tag, Select, Progress, Typography, Switch, Empty, Table } from "antd";
import Statistic from "../../components/Statistic";
import { ArrowUpOutlined, ArrowDownOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  getDefectsOverview,
  getDefectsTrend,
  getDefectsPivot,
  getWriteOffs,
  getProductionDefects,
  type DefectPivotGroupBy,
  type DefectPivotRowOut,
  type ProductionDefectLine,
  type ReasonShareLine,
  type TopDefectGroupLine,
  type TopWriteOffMaterialLine,
  type TrendPoint,
  type WriteOffLine,
} from "../../api/reports";
import ReportTable, { type ReportColumn } from "../../components/ReportTable";
import DictAutoComplete from "../../components/DictAutoComplete";
import { listAreas } from "../../api/areas";
import { listProductionLines } from "../../api/production";
import { listAllWriteOffReasons } from "../../api/writeOffReasons";
import { useAuth } from "../../auth/AuthContext";
import { palette } from "../../theme";
import { WriteOffReasonsTab } from "./DictionaryAdmin";

function DeltaTag({ value, goodDirection }: { value: number | null; goodDirection: "down" | "up" }) {
  if (value === null) return <Tag>нет данных за пред. период</Tag>;
  if (value === 0) return <Tag>без изменений к пред. периоду</Tag>;
  const isUp = value > 0;
  const isGood = goodDirection === "down" ? !isUp : isUp;
  return (
    <Tag color={isGood ? "green" : "red"} icon={isUp ? <ArrowUpOutlined /> : <ArrowDownOutlined />}>
      {isUp ? "+" : ""}
      {value}% к пред. периоду
    </Tag>
  );
}

function RateTag({ value }: { value: number }) {
  const color = value >= 7 ? "red" : value >= 5 ? "orange" : "green";
  return <Tag color={color}>{value}%</Tag>;
}

function ReasonBars({ items, unit, color }: { items: ReasonShareLine[]; unit: string; color: string }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет данных за период" />;
  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      {items.map((r) => (
        <div key={r.reason_name}>
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <span>{r.reason_name}</span>
            <span style={{ color: "rgba(0,0,0,.45)" }}>
              {r.amount} {unit} ({r.share_percent}%)
            </span>
          </Space>
          <Progress percent={r.share_percent} showInfo={false} strokeColor={color} size="small" />
        </div>
      ))}
    </Space>
  );
}

// Динамика по бакетам (обычно неделям) — чистый CSS, без графической
// библиотеки: единственные два ряда цифр (метры склада / штуки брака),
// добавлять зависимость ради них не стали (раздел про быстрый режим —
// бандл и так только что боролись держать компактным).
function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет данных за период" />;
  const maxWarehouse = Math.max(1, ...points.map((p) => p.warehouse_m));
  const maxProduction = Math.max(1, ...points.map((p) => p.production_defect_pieces));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 24, height: 140, padding: "8px 4px 0", overflowX: "auto" }}>
        {points.map((p) => (
          <div
            key={p.label}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: "1 0 40px", height: "100%", justifyContent: "flex-end" }}
          >
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 110 }}>
              <div
                title={`Склад: ${p.warehouse_m} м`}
                style={{
                  width: 16,
                  borderRadius: "3px 3px 0 0",
                  background: palette.orange,
                  height: `${(p.warehouse_m / maxWarehouse) * 100}%`,
                  minHeight: p.warehouse_m > 0 ? 3 : 0,
                }}
              />
              <div
                title={`Производство: ${p.production_defect_pieces} шт`}
                style={{
                  width: 16,
                  borderRadius: "3px 3px 0 0",
                  background: palette.navyLight,
                  height: `${(p.production_defect_pieces / maxProduction) * 100}%`,
                  minHeight: p.production_defect_pieces > 0 ? 3 : 0,
                }}
              />
            </div>
            <span style={{ fontSize: 11, color: "rgba(0,0,0,.45)", whiteSpace: "nowrap" }}>{p.label}</span>
          </div>
        ))}
      </div>
      <Space size={16} style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 8 }}>
        <span>
          <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: palette.orange, marginRight: 5 }} />
          Списания склада, м
        </span>
        <span>
          <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: palette.navyLight, marginRight: 5 }} />
          Брак производства, шт
        </span>
      </Space>
    </div>
  );
}

function DefectsOverviewTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, "day"), dayjs()]);
  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");
  const overviewQuery = useQuery({ queryKey: ["defects-overview", from, to], queryFn: () => getDefectsOverview(from, to) });
  const trendQuery = useQuery({ queryKey: ["defects-trend", from, to], queryFn: () => getDefectsTrend(from, to) });
  const o = overviewQuery.data;

  const materialColumns = [
    { title: "Материал", key: "material", render: (_: unknown, r: TopWriteOffMaterialLine) => `${r.material}, ${r.color}` },
    { title: "Толщина, мм", dataIndex: "thickness" },
    { title: "Списано, м", dataIndex: "amount_m", align: "right" as const },
    { title: "События", dataIndex: "events", align: "right" as const },
  ];

  const defectGroupColumns = [
    {
      title: "Участок / линия",
      key: "label",
      render: (_: unknown, r: TopDefectGroupLine) => (r.level === "line" ? `↳ ${r.label}` : r.label),
    },
    { title: "Брак", dataIndex: "defect_pieces", align: "right" as const, render: (v: number) => `${v} шт` },
    { title: "Годных", dataIndex: "good_pieces", align: "right" as const, render: (v: number) => `${v} шт` },
    { title: "Доля", key: "rate", align: "right" as const, render: (_: unknown, r: TopDefectGroupLine) => <RateTag value={r.defect_rate_percent} /> },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />

      {o && (
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <Card size="small">
              <Statistic title="Списано на складе" value={o.warehouse_total_m} suffix="м" precision={1} />
              <div style={{ marginTop: 8 }}>
                <DeltaTag value={o.warehouse_total_m_delta_percent} goodDirection="down" />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {o.warehouse_events_count} событий списания
              </Typography.Text>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card size="small">
              <Statistic title="— из них отход при раскрое" value={o.warehouse_cutting_waste_m} suffix="м" precision={1} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {o.warehouse_total_m ? Math.round((o.warehouse_cutting_waste_m / o.warehouse_total_m) * 100) : 0}% от списаний — норма
              </Typography.Text>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card size="small">
              <Statistic title="Реальный брак / повреждения" value={o.warehouse_real_defect_m} suffix="м" precision={1} />
              <div style={{ marginTop: 8 }}>
                <DeltaTag value={o.warehouse_real_defect_m_delta_percent} goodDirection="down" />
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card size="small">
              <Statistic title="Брак на производстве" value={o.production_defect_pieces} suffix="шт" />
              <div style={{ marginTop: 8 }}>
                <DeltaTag value={o.production_defect_pieces_delta_percent} goodDirection="down" />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                из {o.production_good_pieces} шт годных — {o.production_defect_rate_percent}%
              </Typography.Text>
            </Card>
          </Col>
        </Row>
      )}

      {o && (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card size="small" title="Причины — склад" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>без отхода при раскрое</Typography.Text>}>
              <ReasonBars items={o.warehouse_reasons} unit="м" color={palette.orange} />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card size="small" title="Причины — производство">
              <ReasonBars items={o.production_reasons} unit="шт" color={palette.navyLight} />
            </Card>
          </Col>
        </Row>
      )}

      <Card size="small" title="Динамика по неделям">
        <TrendChart points={trendQuery.data ?? []} />
      </Card>

      {o && (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card size="small" title="Топ материалов по списаниям">
              <Table
                size="small"
                pagination={false}
                rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
                dataSource={o.top_materials}
                columns={materialColumns}
                locale={{ emptyText: "Нет списаний за период" }}
              />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card size="small" title="Худшие по браку" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>доля от годных</Typography.Text>}>
              <Table
                size="small"
                pagination={false}
                rowKey={(r) => `${r.level}-${r.label}`}
                dataSource={o.top_defect_groups}
                columns={defectGroupColumns}
                locale={{ emptyText: "Нет брака за период" }}
              />
            </Card>
          </Col>
        </Row>
      )}
    </Space>
  );
}

function DefectsPivotTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, "day"), dayjs()]);
  const [groupBy, setGroupBy] = useState<DefectPivotGroupBy>("detail");
  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");
  const query = useQuery({ queryKey: ["defects-pivot", from, to, groupBy], queryFn: () => getDefectsPivot(from, to, groupBy) });
  const pivot = query.data;

  const groupHeader = groupBy === "detail" ? "Деталь" : groupBy === "area" ? "Участок" : "Линия";

  const columns: ReportColumn<DefectPivotRowOut>[] = [
    {
      key: "group_label",
      header: groupHeader,
      render: (r) => (
        <>
          {r.group_label}
          {r.parent_label && (
            <Tag style={{ marginLeft: 6 }} color="default">
              {r.parent_label}
            </Tag>
          )}
        </>
      ),
      printValue: (r) => r.group_label,
    },
    ...(pivot?.reasons ?? []).map(
      (reason): ReportColumn<DefectPivotRowOut> => ({
        key: reason,
        header: reason,
        render: (r) => r.by_reason[reason] ?? 0,
        printValue: (r) => r.by_reason[reason] ?? 0,
      }),
    ),
    {
      key: "defect_pieces",
      header: "Итого брака",
      render: (r) => <b>{r.defect_pieces}</b>,
      printValue: (r) => r.defect_pieces,
      sorter: (a, b) => a.defect_pieces - b.defect_pieces,
      defaultSortOrder: "descend",
    },
    { key: "good_pieces", header: "Годных", render: (r) => r.good_pieces, printValue: (r) => r.good_pieces },
    {
      key: "defect_rate_percent",
      header: "Доля брака",
      render: (r) => <RateTag value={r.defect_rate_percent} />,
      printValue: (r) => r.defect_rate_percent,
      sorter: (a, b) => a.defect_rate_percent - b.defect_rate_percent,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <span style={{ color: "rgba(0,0,0,0.45)" }}>
        Брак на производстве, сгруппированный по выбранному разрезу, с раскладкой по причинам и долей брака от годных изделий.
      </span>
      <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
        <Select<DefectPivotGroupBy>
          value={groupBy}
          onChange={setGroupBy}
          style={{ width: 220 }}
          options={[
            { value: "detail", label: "Группировать по детали" },
            { value: "area", label: "Группировать по участку" },
            { value: "line", label: "Группировать по линии" },
          ]}
        />
      </Space>
      {pivot && (
        <Row gutter={16}>
          <Col xs={12} sm={6}>
            <Statistic title="Итого брака" value={pivot.total.defect_pieces} suffix="шт" />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="Итого годных" value={pivot.total.good_pieces} suffix="шт" />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="Средняя доля брака" value={pivot.total.defect_rate_percent} suffix="%" />
          </Col>
        </Row>
      )}
      <ReportTable
        title={`Брак по разрезу «${groupHeader}»`}
        filename={`brak-po-${groupBy}.csv`}
        rowKey={(r) => r.group_label}
        columns={columns}
        data={pivot?.rows ?? []}
        loading={query.isLoading}
      />
      {groupBy === "line" && (
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          Линия видна только у отчётов, привязанных к конкретному распределению (день/линия/бригада) — старые отчёты без
          этой привязки в разрезе «Линия» не показываются, но учтены в разрезе «Участок».
        </Typography.Text>
      )}
    </Space>
  );
}

function WriteOffsTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(6, "day"), dayjs()]);
  const [material, setMaterial] = useState<string>();
  const [reason, setReason] = useState<string>();
  const [includeCuttingWaste, setIncludeCuttingWaste] = useState(false);
  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");
  const query = useQuery({
    queryKey: ["report-write-offs", from, to, reason, includeCuttingWaste],
    queryFn: () => getWriteOffs(from, to, { reason, includeCuttingWaste }),
  });
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "all"], queryFn: listAllWriteOffReasons });

  const rows = (query.data ?? []).filter((r) => !material || r.material === material);

  const columns: ReportColumn<WriteOffLine>[] = [
    {
      key: "timestamp",
      header: "Когда",
      render: (r) => new Date(r.timestamp).toLocaleString("ru-RU"),
      printValue: (r) => new Date(r.timestamp).toLocaleString("ru-RU"),
      sorter: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      defaultSortOrder: "descend",
    },
    { key: "material", header: "Материал", render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`, printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
    { key: "width_mm", header: "Ширина, мм", render: (r) => r.width_mm, printValue: (r) => r.width_mm },
    { key: "quantity_m", header: "Списано, м", render: (r) => r.quantity_m, printValue: (r) => r.quantity_m, sorter: (a, b) => a.quantity_m - b.quantity_m },
    {
      key: "reason_name",
      header: "Причина",
      render: (r) => (r.reason_name ? <Tag color={r.is_cutting_waste ? "default" : "orange"}>{r.reason_name}</Tag> : "—"),
      printValue: (r) => r.reason_name ?? "",
    },
    { key: "note", header: "Заметка", render: (r) => r.note ?? "—", printValue: (r) => r.note ?? "" },
    { key: "user_name", header: "Кто", render: (r) => r.user_name, printValue: (r) => r.user_name },
    { key: "unit_id", header: "Единица", render: (r) => `№ ${r.unit_id}`, printValue: (r) => r.unit_id },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
        <DictAutoComplete kind="materials" placeholder="Материал" value={material} onChange={(v) => setMaterial(v || undefined)} allowCreate={false} />
        <Select
          allowClear
          placeholder="Причина"
          style={{ width: 220 }}
          value={reason}
          onChange={setReason}
          options={(reasonsQuery.data ?? []).filter((r) => !r.is_system).map((r) => ({ value: r.code, label: r.name }))}
        />
        <Space>
          <Switch checked={includeCuttingWaste} onChange={setIncludeCuttingWaste} />
          <span>Показывать отход при раскрое</span>
        </Space>
      </Space>
      <ReportTable title="Списания по складу" filename="spisaniya-po-skladu.csv" rowKey="event_id" columns={columns} data={rows} loading={query.isLoading} />
    </Space>
  );
}

function ProductionDefectsTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(6, "day"), dayjs()]);
  const [area, setArea] = useState<string>();
  const [lineId, setLineId] = useState<number>();
  const [reason, setReason] = useState<string>();
  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");
  const query = useQuery({
    queryKey: ["report-production-defects", from, to, area, lineId, reason],
    queryFn: () => getProductionDefects(from, to, { area, lineId, reason }),
  });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "all"], queryFn: listAllWriteOffReasons });

  const rows = query.data ?? [];
  const columns: ReportColumn<ProductionDefectLine>[] = [
    {
      key: "reported_at",
      header: "Дата",
      render: (r) => new Date(r.reported_at).toLocaleDateString("ru-RU"),
      printValue: (r) => new Date(r.reported_at).toLocaleDateString("ru-RU"),
      sorter: (a, b) => new Date(a.reported_at).getTime() - new Date(b.reported_at).getTime(),
      defaultSortOrder: "descend",
    },
    { key: "task_name", header: "Задание", render: (r) => r.task_name ?? "—", printValue: (r) => r.task_name ?? "" },
    { key: "part_name", header: "Деталь", render: (r) => r.part_name ?? "—", printValue: (r) => r.part_name ?? "" },
    { key: "area_name", header: "Участок", render: (r) => r.area_name, printValue: (r) => r.area_name },
    { key: "line_name", header: "Линия", render: (r) => r.line_name ?? "—", printValue: (r) => r.line_name ?? "" },
    { key: "defect_pieces", header: "Брак", render: (r) => r.defect_pieces, printValue: (r) => r.defect_pieces, sorter: (a, b) => a.defect_pieces - b.defect_pieces },
    { key: "good_pieces", header: "Годных", render: (r) => r.good_pieces, printValue: (r) => r.good_pieces },
    { key: "reason_name", header: "Причина", render: (r) => r.reason_name ?? "—", printValue: (r) => r.reason_name ?? "" },
    { key: "note", header: "Заметка", render: (r) => r.note ?? "—", printValue: (r) => r.note ?? "" },
    { key: "reported_by_name", header: "Сообщил", render: (r) => r.reported_by_name, printValue: (r) => r.reported_by_name },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
        <Select
          allowClear
          placeholder="Участок"
          style={{ width: 180 }}
          value={area}
          onChange={setArea}
          options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
        />
        <Select
          allowClear
          placeholder="Линия"
          style={{ width: 180 }}
          value={lineId}
          onChange={setLineId}
          options={(linesQuery.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
        />
        <Select
          allowClear
          placeholder="Причина"
          style={{ width: 220 }}
          value={reason}
          onChange={setReason}
          options={(reasonsQuery.data ?? []).filter((r) => !r.is_system).map((r) => ({ value: r.code, label: r.name }))}
        />
      </Space>
      <ReportTable title="Брак на производстве" filename="brak-na-proizvodstve.csv" rowKey="report_id" columns={columns} data={rows} loading={query.isLoading} />
    </Space>
  );
}

export default function Defects() {
  const { user } = useAuth();
  const canManageReasons = !!user?.is_superuser || !!user?.permissions.includes("materials.manage");

  return (
    <Card title="Брак и списания">
      <Tabs
        items={[
          { key: "overview", label: "Обзор", children: <DefectsOverviewTab /> },
          { key: "pivot", label: "Сводная таблица", children: <DefectsPivotTab /> },
          { key: "warehouse", label: "Списания по складу", children: <WriteOffsTab /> },
          { key: "production", label: "Брак на производстве", children: <ProductionDefectsTab /> },
          // "Причины" — та же вкладка, что в Справочниках (тот же компонент,
          // не дубликат), видна только тем, кто и там мог бы её редактировать
          // (materials.manage) — иначе список причин требует его же права на
          // /write-off-reasons/all и упал бы 403 у остальных пользователей
          // с доступом только к отчётам (reports.view).
          ...(canManageReasons ? [{ key: "reasons", label: "Причины", children: <WriteOffReasonsTab /> }] : []),
        ]}
      />
    </Card>
  );
}
