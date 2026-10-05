import { useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { Alert, Card, Col, DatePicker, Row, Segmented, Select, Space, Tabs, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getDailyOutput, getFilmPlanFact, getOutput, type DailyRow, type FilmPlanFactRow, type OutputRow } from "../../api/economics";
import { listAreas } from "../../api/areas";
import Statistic from "../../components/Statistic";
import ResponsiveTable from "../../components/ResponsiveTable";

const f1 = (n: number | null | undefined) => (n == null ? "—" : (Math.round(n * 10) / 10).toLocaleString("ru-RU"));
const rub = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n).toLocaleString("ru-RU")} ₽`);

type FilmGroup = "line" | "order" | "area" | "film";

interface FilmAgg {
  key: string;
  label: string;
  sub?: string;
  norm_m: number;
  defect_m: number;
  fact_m: number;
  over_m: number;
  over_rub: number | null;
  in_work: boolean;
  no_roll: number;
  lines: number;
}

function aggregateFilm(rows: FilmPlanFactRow[], by: FilmGroup): FilmAgg[] {
  const m = new Map<string, FilmAgg>();
  for (const r of rows) {
    const key =
      by === "line" ? String(r.line_id) : by === "order" ? r.invoice_no || r.order || "без заказа" : by === "area" ? r.area_name : r.film;
    const label =
      by === "line" ? r.part_name ?? "—" : by === "order" ? (r.invoice_no ? `счёт ${r.invoice_no}` : r.order ?? "без заказа") : key;
    const sub = by === "line" ? `${r.area_name} · ${r.film}${r.order ? ` · ${r.order}` : ""}` : by === "order" && r.invoice_no ? r.order ?? undefined : undefined;
    const a = m.get(key) ?? { key, label, sub, norm_m: 0, defect_m: 0, fact_m: 0, over_m: 0, over_rub: null, in_work: false, no_roll: 0, lines: 0 };
    a.norm_m += r.norm_m;
    a.defect_m += r.defect_m;
    a.fact_m += r.fact_m ?? r.norm_m;
    a.over_m += r.over_m ?? 0;
    if (r.over_rub != null) a.over_rub = (a.over_rub ?? 0) + r.over_rub;
    a.in_work = a.in_work || r.in_work;
    a.no_roll += r.no_roll_pieces;
    a.lines += 1;
    m.set(key, a);
  }
  return [...m.values()].sort((a, b) => b.over_m - a.over_m);
}

function FilmTab({ rows, loading }: { rows: FilmPlanFactRow[]; loading: boolean }) {
  const [by, setBy] = useState<FilmGroup>("order");
  const data = useMemo(() => aggregateFilm(rows, by), [rows, by]);
  const t = useMemo(() => aggregateFilm(rows, "area").reduce(
    (s, a) => ({ norm: s.norm + a.norm_m, defect: s.defect + a.defect_m, fact: s.fact + a.fact_m, over: s.over + a.over_m, rub: s.rub + (a.over_rub ?? 0) }),
    { norm: 0, defect: 0, fact: 0, over: 0, rub: 0 },
  ), [rows]);
  const unpriced = rows.filter((r) => r.price_m2 == null).length;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Норма, м" value={f1(t.norm)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Факт, м" value={f1(t.fact)} /></Card></Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Перерасход, м" value={`${f1(t.over)}${t.norm ? ` (${f1((t.over / t.norm) * 100)}%)` : ""}`} />
          </Card>
        </Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Из них брак, м" value={f1(t.defect)} /></Card></Col>
      </Row>
      {unpriced > 0 && (
        <Alert
          type="info"
          showIcon
          message={`Рубли не посчитаны у ${unpriced} из ${rows.length} строк — нет цены м² этой плёнки`}
          description="Цена берётся из заявок поставщику («Закупки»): у плёнки появится цена — появятся и рубли."
        />
      )}
      <Space wrap>
        <Segmented
          value={by}
          onChange={(v) => setBy(v as FilmGroup)}
          options={[
            { value: "order", label: "По счетам/заказам" },
            { value: "area", label: "По участкам" },
            { value: "film", label: "По плёнке" },
            { value: "line", label: "По строкам" },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Норма — годные × длина детали; факт — по рулонам (выдано − вернули); перерасход — брак, обрезки, недоучёт.
        </Typography.Text>
      </Space>
      <ResponsiveTable<FilmAgg>
        exportTitle="План/факт плёнки"
        size="small"
        rowKey="key"
        loading={loading}
        dataSource={data}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        scroll={{ x: "max-content" }}
        columns={[
          {
            title: by === "line" ? "Деталь" : by === "order" ? "Счёт / заказ" : by === "area" ? "Участок" : "Плёнка",
            render: (_, a) => (
              <Space direction="vertical" size={0}>
                <span>{a.label}</span>
                {a.sub && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{a.sub}</Typography.Text>}
              </Space>
            ),
          },
          ...(by !== "line" ? [{ title: "Строк", dataIndex: "lines", align: "right" as const }] : []),
          { title: "Норма, м", align: "right", sorter: (a, b) => a.norm_m - b.norm_m, render: (_, a) => f1(a.norm_m) },
          { title: "Брак, м", align: "right", render: (_, a) => f1(a.defect_m) },
          { title: "Факт, м", align: "right", render: (_, a) => f1(a.fact_m) },
          {
            title: "Перерасход",
            align: "right",
            sorter: (a, b) => a.over_m - b.over_m,
            render: (_, a) => {
              const pct = a.norm_m ? (a.over_m / a.norm_m) * 100 : null;
              const color = pct == null ? undefined : pct > 20 ? "red" : pct > 8 ? "orange" : "green";
              return (
                <Space size={4}>
                  <span>{f1(a.over_m)} м</span>
                  {pct != null && <Tag color={color}>{f1(pct)}%</Tag>}
                </Space>
              );
            },
          },
          { title: "Перерасход, ₽", align: "right", render: (_, a) => rub(a.over_rub) },
          {
            title: "",
            render: (_, a) => (
              <Space size={4} wrap>
                {a.in_work && (
                  <Tooltip title="Часть рулонов ещё на участке — факт по ним пока по отчётам, уточнится при возврате">
                    <Tag>в работе</Tag>
                  </Tooltip>
                )}
                {a.no_roll > 0 && (
                  <Tooltip title="Часть отчётов подана без рулона — их плёнка попала в факт других строк">
                    <Tag color="gold">без рулона: {f1(a.no_roll)} шт</Tag>
                  </Tooltip>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

type OutGroup = "user" | "area" | "date";

function OutputTab({ rows, loading }: { rows: OutputRow[]; loading: boolean }) {
  const [by, setBy] = useState<OutGroup>("user");
  const data = useMemo(() => {
    const m = new Map<string, { key: string; label: string; good: number; defect: number; reports: number; days: Set<string>; capacity: number | null }>();
    for (const r of rows) {
      const key = by === "user" ? r.user : by === "area" ? r.area_name : r.date;
      const a = m.get(key) ?? { key, label: by === "date" ? dayjs(key).format("DD.MM.YYYY, dd") : key, good: 0, defect: 0, reports: 0, days: new Set<string>(), capacity: by === "area" ? r.capacity : null };
      a.good += r.good;
      a.defect += r.defect;
      a.reports += r.reports;
      a.days.add(r.date);
      m.set(key, a);
    }
    return [...m.values()].sort((a, b) => (by === "date" ? b.key.localeCompare(a.key) : b.good - a.good));
  }, [rows, by]);
  const good = rows.reduce((s, r) => s + r.good, 0);
  const defect = rows.reduce((s, r) => s + r.defect, 0);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Годных, шт" value={f1(good)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Брак, шт" value={f1(defect)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Доля брака" value={`${good + defect ? f1((defect / (good + defect)) * 100) : 0}%`} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Сотрудников" value={new Set(rows.map((r) => r.user)).size} /></Card></Col>
      </Row>
      <Segmented
        value={by}
        onChange={(v) => setBy(v as OutGroup)}
        options={[
          { value: "user", label: "По сотрудникам" },
          { value: "area", label: "По участкам" },
          { value: "date", label: "По дням" },
        ]}
      />
      <ResponsiveTable
        exportTitle="Выработка"
        size="small"
        rowKey="key"
        loading={loading}
        dataSource={data}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        columns={[
          { title: by === "user" ? "Сотрудник" : by === "area" ? "Участок" : "День", dataIndex: "label" },
          { title: "Годных, шт", align: "right", sorter: (a, b) => a.good - b.good, render: (_, a) => f1(a.good) },
          { title: "Брак, шт", align: "right", render: (_, a) => f1(a.defect) },
          {
            title: "Доля брака",
            align: "right",
            render: (_, a) => {
              const pct = a.good + a.defect ? (a.defect / (a.good + a.defect)) * 100 : 0;
              return <Tag color={pct > 8 ? "red" : pct > 4 ? "orange" : "green"}>{f1(pct)}%</Tag>;
            },
          },
          ...(by !== "date"
            ? [
                { title: "Дней с отчётами", align: "right" as const, render: (_: unknown, a: (typeof data)[number]) => a.days.size },
                { title: "В среднем за день, шт", align: "right" as const, render: (_: unknown, a: (typeof data)[number]) => f1(a.good / Math.max(1, a.days.size)) },
              ]
            : []),
          ...(by === "area"
            ? [{ title: "Мощность в день", align: "right" as const, render: (_: unknown, a: (typeof data)[number]) => (a.capacity ? f1(a.capacity) : "не задана") }]
            : []),
          { title: "Отчётов", align: "right", dataIndex: "reports" },
        ]}
      />
    </Space>
  );
}

/** Ежедневная выработка: строки — участки и работы склада плёнки, столбцы —
 * дни; клик по ячейке — кто сколько сделал в этот день. */
function DailyTab({ days, rows, loading }: { days: string[]; rows: DailyRow[]; loading: boolean }) {
  const [sel, setSel] = useState<{ row: DailyRow; day: string } | null>(null);
  const fmtCell = (r: DailyRow, v: number, x: number) =>
    r.group === "production" ? (
      <Space direction="vertical" size={0}>
        <b>{f1(v)}</b>
        {x > 0 && <Typography.Text type="danger" style={{ fontSize: 11 }}>брак {f1(x)}</Typography.Text>}
      </Space>
    ) : (
      <Space direction="vertical" size={0}>
        <b>{f1(v)}</b>
        {x > 0 && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.extra_label === "метров" ? `${f1(x)} м` : `${f1(x)} ед.`}</Typography.Text>}
      </Space>
    );
  const data: (DailyRow | { key: string; header: string })[] = [];
  const prod = rows.filter((r) => r.group === "production");
  const wh = rows.filter((r) => r.group === "warehouse");
  if (prod.length) data.push({ key: "h-prod", header: "Производство — годных, шт (брак)" }, ...prod);
  if (wh.length) data.push({ key: "h-wh", header: "Склад плёнки — операций (метров / единиц)" }, ...wh);
  const isHead = (r: DailyRow | { key: string; header: string }): r is { key: string; header: string } => "header" in r;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <ResponsiveTable
        exportTitle="Выработка по дням"
        size="small"
        rowKey="key"
        loading={loading}
        dataSource={data}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "За период отчётов и операций нет" }}
        columns={[
          {
            title: "Участок / работа",
            fixed: "left",
            onCell: (r) => (isHead(r) ? { colSpan: days.length + 2 } : {}),
            render: (_, r) =>
              isHead(r) ? (
                <Typography.Text strong>{r.header}</Typography.Text>
              ) : (
                <Space direction="vertical" size={0}>
                  <span>{r.label}</span>
                  {r.capacity ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>мощность {f1(r.capacity)} в день</Typography.Text> : null}
                </Space>
              ),
          },
          {
            title: "Итого",
            onCell: (r) => (isHead(r) ? { colSpan: 0 } : {}),
            render: (_, r) => (isHead(r) ? null : fmtCell(r, r.total, r.total_extra)),
          },
          ...days.map((d) => ({
            title: dayjs(d).format("DD.MM dd"),
            align: "right" as const,
            onCell: (r: DailyRow | { key: string; header: string }) => {
              if (isHead(r)) return { colSpan: 0 };
              const c = r.by_day[d];
              const over = r.capacity && c ? c.value > r.capacity : false;
              return {
                onClick: c ? () => setSel({ row: r, day: d }) : undefined,
                style: {
                  cursor: c ? "pointer" : undefined,
                  background: sel && sel.row.key === r.key && sel.day === d ? "rgba(200,120,40,.15)" : over ? "rgba(46,125,74,.08)" : undefined,
                },
              };
            },
            render: (_: unknown, r: DailyRow | { key: string; header: string }) => {
              if (isHead(r)) return null;
              const c = r.by_day[d];
              return c ? fmtCell(r, c.value, c.extra) : <Typography.Text type="secondary">—</Typography.Text>;
            },
          })),
        ]}
      />
      {sel && (
        <Card size="small" title={`${sel.row.label} — ${dayjs(sel.day).format("DD.MM.YYYY, dddd")}`}>
          <ResponsiveTable
            exportTitle={`Выработка за день: ${sel.row.label}, ${dayjs(sel.day).format("DD.MM.YYYY")}`}
            size="small"
            rowKey="user"
            pagination={false}
            dataSource={sel.row.by_day[sel.day]?.users ?? []}
            columns={[
              { title: "Сотрудник", dataIndex: "user" },
              { title: sel.row.value_label, align: "right", render: (_, u) => f1(u.value) },
              { title: sel.row.extra_label, align: "right", render: (_, u) => f1(u.extra) },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}

/** Экономика производства (02.10): план/факт плёнки против норм и выработка.
 * Себестоимость (материалы, труд) — когда появятся цены материалов и ставки. */
export default function Economics({ embedded = false }: { embedded?: boolean }) {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(30, "day"), dayjs()]);
  const [area, setArea] = useState<string | undefined>();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const p = { date_from: range[0].format("YYYY-MM-DD"), date_to: range[1].format("YYYY-MM-DD"), area };
  const film = useQuery({ queryKey: ["economics", "film", p], queryFn: () => getFilmPlanFact(p) });
  const out = useQuery({ queryKey: ["economics", "output", p], queryFn: () => getOutput(p) });
  const daily = useQuery({
    queryKey: ["economics", "daily", p.date_from, p.date_to],
    queryFn: () => getDailyOutput({ date_from: p.date_from, date_to: p.date_to }),
  });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card title={embedded ? undefined : "Экономика производства"} size={embedded ? "small" : undefined}>
        <Space wrap>
          <DatePicker.RangePicker format="DD.MM.YYYY" value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
          <Select
            allowClear
            placeholder="Все участки"
            style={{ width: 260 }}
            value={area}
            onChange={setArea}
            options={(areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
          />
          <Typography.Text type="secondary">Период — по датам отчётов мастеров и операций склада.</Typography.Text>
        </Space>
      </Card>
      <Tabs
        items={[
          {
            key: "daily",
            label: "По дням",
            children: <DailyTab days={daily.data?.days ?? []} rows={daily.data?.rows ?? []} loading={daily.isLoading} />,
          },
          { key: "film", label: "План/факт плёнки", children: <FilmTab rows={film.data ?? []} loading={film.isLoading} /> },
          { key: "output", label: "Выработка", children: <OutputTab rows={out.data ?? []} loading={out.isLoading} /> },
        ]}
      />
    </Space>
  );
}
