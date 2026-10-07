import { useMemo, useState } from "react";
import { Button, Card, DatePicker, Select, Space, Table, Tabs, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import { listAreas } from "../../api/areas";
import { getProductivity, type AreaTotal, type IssueRow, type OutputRow } from "../../api/productivity";
import { exportBook } from "../../utils/excel";
import { useTabTitle } from "../../layout/tabTitle";

const n = (v: number | null | undefined, digits = 2) => (v == null ? "—" : `${Math.round(v * 10 ** digits) / 10 ** digits}`);
const d = (s: string) => dayjs(s).format("DD.MM.YYYY");

type DayRow = {
  key: string;
  day: string;
  area_name: string;
  good: number;
  defect: number;
  defect_percent: number | null;
  film_m: number;
  issued_units: number;
  issued_m: number;
  issued_m2: number;
};

/** Производительность участков (07.10): сколько и чего сделано за период —
 * по участкам, по дням, по позициям — и сколько плёнки выдано участкам.
 * Выпуск — из отчётов мастеров (закрытие «всё сделано» без отчёта тоже
 * считается и показано отдельно), выдача — из событий выдачи рулонов.
 * «Выгрузить в Excel» — все вкладки листами одной книги. */
export default function Productivity() {
  useTabTitle("Производительность участков");
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [area, setArea] = useState<string | undefined>();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const params = { date_from: range[0].format("YYYY-MM-DD"), date_to: range[1].format("YYYY-MM-DD"), area };
  const q = useQuery({ queryKey: ["productivity", params], queryFn: () => getProductivity(params) });
  const data = q.data;

  const byDay: DayRow[] = useMemo(() => {
    const m = new Map<string, DayRow>();
    const get = (day: string, area_name: string) => {
      const key = `${day}|${area_name}`;
      let r = m.get(key);
      if (!r) {
        r = { key, day, area_name, good: 0, defect: 0, defect_percent: null, film_m: 0, issued_units: 0, issued_m: 0, issued_m2: 0 };
        m.set(key, r);
      }
      return r;
    };
    for (const o of data?.output ?? []) {
      const r = get(o.day, o.area_name);
      r.good += o.good;
      r.defect += o.defect;
      r.film_m += o.film_m;
    }
    for (const i of data?.issues ?? []) {
      const r = get(i.day, i.area_name);
      r.issued_units += i.rolls + i.strips;
      r.issued_m += i.length_m;
      r.issued_m2 += i.area_m2;
    }
    for (const r of m.values()) r.defect_percent = r.good + r.defect ? (r.defect / (r.good + r.defect)) * 100 : null;
    return [...m.values()].sort((a, b) => (a.day === b.day ? a.area_name.localeCompare(b.area_name) : b.day.localeCompare(a.day)));
  }, [data]);

  const totalCols = [
    { key: "area_name", header: "Участок" },
    { key: "good", header: "Годных, шт" },
    { key: "defect", header: "Брак, шт" },
    { key: "defect_percent", header: "Брак, %" },
    { key: "days_with_output", header: "Дней с выпуском" },
    { key: "good_per_day", header: "Годных в день" },
    { key: "film_used_m", header: "Плёнки израсходовано, м" },
    { key: "issued_units", header: "Выдано рулонов/штрипсов" },
    { key: "issued_m", header: "Выдано плёнки, м" },
    { key: "issued_m2", header: "Выдано плёнки, м²" },
  ];
  const dayCols = [
    { key: "day", header: "Дата" },
    { key: "area_name", header: "Участок" },
    { key: "good", header: "Годных, шт" },
    { key: "defect", header: "Брак, шт" },
    { key: "defect_percent", header: "Брак, %" },
    { key: "film_m", header: "Плёнки израсходовано, м" },
    { key: "issued_units", header: "Выдано рулонов/штрипсов" },
    { key: "issued_m", header: "Выдано, м" },
    { key: "issued_m2", header: "Выдано, м²" },
  ];
  const outCols = [
    { key: "day", header: "Дата" },
    { key: "area_name", header: "Участок" },
    { key: "position", header: "Позиция" },
    { key: "good", header: "Годных, шт" },
    { key: "defect", header: "Брак, шт" },
    { key: "film_m", header: "Плёнки, м" },
    { key: "closed_whole", header: "Из них закрыто без отчёта, шт" },
    { key: "reports", header: "Отчётов" },
  ];
  const issueCols = [
    { key: "day", header: "Дата" },
    { key: "area_name", header: "Участок" },
    { key: "film", header: "Плёнка" },
    { key: "rolls", header: "Рулонов" },
    { key: "strips", header: "Штрипсов" },
    { key: "length_m", header: "Длина, м" },
    { key: "area_m2", header: "Площадь, м²" },
  ];
  const round = <T extends Record<string, unknown>>(rows: T[]) =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : k === "day" ? d(String(v)) : v])));
  const exportAll = () => {
    if (!data) return;
    const areaName = area ? (areasQuery.data ?? []).find((a) => a.code === area)?.name ?? area : "все участки";
    exportBook(`Производительность ${range[0].format("DD.MM.YYYY")}-${range[1].format("DD.MM.YYYY")} ${areaName}`, [
      { name: "По участкам", rows: round(data.totals as unknown as Record<string, unknown>[]), columns: totalCols },
      { name: "По дням", rows: round(byDay as unknown as Record<string, unknown>[]), columns: dayCols },
      { name: "По позициям", rows: round(data.output as unknown as Record<string, unknown>[]), columns: outCols },
      { name: "Выдача плёнки", rows: round(data.issues as unknown as Record<string, unknown>[]), columns: issueCols },
    ]);
  };

  const sum = <T,>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
  const presets: { label: string; value: [Dayjs, Dayjs] }[] = [
    { label: "Сегодня", value: [dayjs(), dayjs()] },
    { label: "Вчера", value: [dayjs().subtract(1, "day"), dayjs().subtract(1, "day")] },
    { label: "Эта неделя", value: [dayjs().startOf("week"), dayjs()] },
    { label: "Этот месяц", value: [dayjs().startOf("month"), dayjs()] },
    { label: "Прошлый месяц", value: [dayjs().subtract(1, "month").startOf("month"), dayjs().subtract(1, "month").endOf("month")] },
  ];

  return (
    <Card title="Производительность участков">
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space wrap>
          <DatePicker.RangePicker
            value={range}
            onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])}
            format="DD.MM.YYYY"
            allowClear={false}
            presets={presets}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Все участки"
            style={{ width: 300 }}
            value={area}
            onChange={setArea}
            options={(areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
          />
          <Button icon={<DownloadOutlined />} onClick={exportAll} disabled={!data}>
            Выгрузить в Excel
          </Button>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          Выпуск — по отчётам мастеров за дату отчёта; закрытие задания «всё сделано» без отчётов засчитывается в день закрытия.
          Выдача — рулоны и штрипсы, выданные складом участку.
        </Typography.Text>
        <Tabs
          items={[
            {
              key: "areas",
              label: "По участкам",
              children: (
                <Table<AreaTotal>
                  size="small"
                  rowKey="area"
                  loading={q.isFetching}
                  dataSource={data?.totals ?? []}
                  pagination={false}
                  scroll={{ x: "max-content" }}
                  locale={{ emptyText: "За период нет ни выпуска, ни выдачи" }}
                  columns={[
                    { title: "Участок", dataIndex: "area_name" },
                    { title: "Годных, шт", align: "right", render: (_, r) => <b>{n(r.good)}</b> },
                    { title: "Брак, шт", align: "right", render: (_, r) => n(r.defect) },
                    { title: "Брак, %", align: "right", render: (_, r) => n(r.defect_percent, 1) },
                    { title: "Дней с выпуском", align: "right", dataIndex: "days_with_output" },
                    { title: "Годных в день", align: "right", render: (_, r) => n(r.good_per_day, 1) },
                    { title: "Плёнки израсх., м", align: "right", render: (_, r) => n(r.film_used_m) },
                    { title: "Выдано рул./штр.", align: "right", dataIndex: "issued_units" },
                    { title: "Выдано, м", align: "right", render: (_, r) => n(r.issued_m) },
                    { title: "Выдано, м²", align: "right", render: (_, r) => n(r.issued_m2) },
                  ]}
                  summary={(rows) =>
                    rows.length > 1 ? (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0}><b>Итого</b></Table.Summary.Cell>
                        <Table.Summary.Cell index={1} align="right"><b>{n(sum(rows, (r) => r.good))}</b></Table.Summary.Cell>
                        <Table.Summary.Cell index={2} align="right">{n(sum(rows, (r) => r.defect))}</Table.Summary.Cell>
                        <Table.Summary.Cell index={3} />
                        <Table.Summary.Cell index={4} />
                        <Table.Summary.Cell index={5} />
                        <Table.Summary.Cell index={6} align="right">{n(sum(rows, (r) => r.film_used_m))}</Table.Summary.Cell>
                        <Table.Summary.Cell index={7} align="right">{sum(rows, (r) => r.issued_units)}</Table.Summary.Cell>
                        <Table.Summary.Cell index={8} align="right">{n(sum(rows, (r) => r.issued_m))}</Table.Summary.Cell>
                        <Table.Summary.Cell index={9} align="right">{n(sum(rows, (r) => r.issued_m2))}</Table.Summary.Cell>
                      </Table.Summary.Row>
                    ) : null
                  }
                />
              ),
            },
            {
              key: "days",
              label: "По дням",
              children: (
                <Table<DayRow>
                  size="small"
                  rowKey="key"
                  loading={q.isFetching}
                  dataSource={byDay}
                  pagination={{ pageSize: 50 }}
                  scroll={{ x: "max-content" }}
                  columns={[
                    { title: "Дата", render: (_, r) => d(r.day) },
                    { title: "Участок", dataIndex: "area_name" },
                    { title: "Годных, шт", align: "right", render: (_, r) => <b>{n(r.good)}</b> },
                    { title: "Брак, шт", align: "right", render: (_, r) => n(r.defect) },
                    { title: "Брак, %", align: "right", render: (_, r) => n(r.defect_percent, 1) },
                    { title: "Плёнки израсх., м", align: "right", render: (_, r) => n(r.film_m) },
                    { title: "Выдано рул./штр.", align: "right", dataIndex: "issued_units" },
                    { title: "Выдано, м", align: "right", render: (_, r) => n(r.issued_m) },
                    { title: "Выдано, м²", align: "right", render: (_, r) => n(r.issued_m2) },
                  ]}
                />
              ),
            },
            {
              key: "positions",
              label: "По позициям",
              children: (
                <Table<OutputRow>
                  size="small"
                  rowKey={(r) => `${r.day}|${r.area}|${r.position}`}
                  loading={q.isFetching}
                  dataSource={data?.output ?? []}
                  pagination={{ pageSize: 50 }}
                  scroll={{ x: "max-content" }}
                  columns={[
                    { title: "Дата", render: (_, r) => d(r.day) },
                    { title: "Участок", dataIndex: "area_name" },
                    { title: "Позиция", dataIndex: "position" },
                    { title: "Годных, шт", align: "right", render: (_, r) => <b>{n(r.good)}</b> },
                    { title: "Брак, шт", align: "right", render: (_, r) => n(r.defect) },
                    { title: "Плёнки, м", align: "right", render: (_, r) => n(r.film_m) },
                    { title: "Без отчёта, шт", align: "right", render: (_, r) => (r.closed_whole ? n(r.closed_whole) : "") },
                    { title: "Отчётов", align: "right", dataIndex: "reports" },
                  ]}
                />
              ),
            },
            {
              key: "issues",
              label: "Выдача плёнки",
              children: (
                <Table<IssueRow>
                  size="small"
                  rowKey={(r) => `${r.day}|${r.area}|${r.film}`}
                  loading={q.isFetching}
                  dataSource={data?.issues ?? []}
                  pagination={{ pageSize: 50 }}
                  scroll={{ x: "max-content" }}
                  columns={[
                    { title: "Дата", render: (_, r) => d(r.day) },
                    { title: "Участок", dataIndex: "area_name" },
                    { title: "Плёнка", dataIndex: "film" },
                    { title: "Рулонов", align: "right", dataIndex: "rolls" },
                    { title: "Штрипсов", align: "right", dataIndex: "strips" },
                    { title: "Длина, м", align: "right", render: (_, r) => n(r.length_m) },
                    { title: "Площадь, м²", align: "right", render: (_, r) => n(r.area_m2) },
                  ]}
                />
              ),
            },
          ]}
        />
      </Space>
    </Card>
  );
}
