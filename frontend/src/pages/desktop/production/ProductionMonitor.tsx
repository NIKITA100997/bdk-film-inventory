import { useMemo, useState } from "react";
import { Button, Card, Progress, Segmented, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { getProductionMonitor, type MonitorArea, type MonitorRow } from "../../../api/productionMonitor";
import { DIRECTIONS } from "../../../utils/itemAttrs";
import { exportBook } from "../../../utils/excel";
import { useTabTitle } from "../../../layout/tabTitle";

const NO_ORDER = 0; // задания цеха без заказа
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (done: number, plan: number) => (plan > 0 ? Math.round((Math.min(done, plan) / plan) * 100) : 100);
const dm = (s: string | null) => (s ? dayjs(s).format("DD.MM") : "");
const done = (r: MonitorRow) => Math.min(r.good, r.plan);
const left = (r: MonitorRow) => (r.closed ? 0 : Math.max(0, r.plan - r.good));
const cellColor = (p: number, started: boolean) => (p >= 100 ? "#389e0d" : started ? "#C97A2B" : undefined);

type Sum = { plan: number; done: number; defect: number; left: number; lines: number; open: number; last: string | null };
const sum = (rows: MonitorRow[]): Sum => {
  const s: Sum = { plan: 0, done: 0, defect: 0, left: 0, lines: rows.length, open: 0, last: null };
  for (const r of rows) {
    s.plan += r.plan;
    s.done += r.closed ? r.plan : done(r);
    s.defect += r.defect;
    s.left += left(r);
    if (left(r) > 0) s.open += 1;
    if (r.last_report && (!s.last || r.last_report > s.last)) s.last = r.last_report;
  }
  return s;
};

/** Монитор производства (08.10) — замена Excel «Монитор … запуск»: по всем
 * открытым заданиям сразу. «Участки» — итог и узкое место; «Заказы ×
 * участки» — сделано/план в клетке; «По участку» — лист участка поперёк
 * заказов (как листы «Каркас», «Окутка», «Склейка» в Excel). */
export default function ProductionMonitor() {
  useTabTitle("Монитор производства");
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ["production-monitor"], queryFn: getProductionMonitor, refetchInterval: 120_000 });
  const [direction, setDirection] = useState<string | undefined>();
  const [site, setSite] = useState<string | undefined>();
  const [orderIds, setOrderIds] = useState<number[]>([]);
  const [hideDone, setHideDone] = useState(true);
  const tab = params.get("tab") ?? "areas";
  const areaParam = params.get("area") ?? undefined;
  const orderParam = params.get("order");
  const go = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v == null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };

  const data = q.data;
  const areaBy = useMemo(() => new Map((data?.areas ?? []).map((a) => [a.code, a])), [data]);
  const orderBy = useMemo(() => new Map((data?.orders ?? []).map((o) => [o.id, o])), [data]);
  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) =>
          (!direction || r.direction === direction) &&
          (!site || areaBy.get(r.area)?.site === site) &&
          (!orderIds.length || orderIds.includes(r.order_id ?? NO_ORDER)),
      ),
    [data, direction, site, orderIds, areaBy],
  );
  const areas = useMemo(() => {
    const used = new Set(rows.map((r) => r.area));
    return (data?.areas ?? []).filter((a) => used.has(a.code));
  }, [data, rows]);
  const sites = [...new Set((data?.areas ?? []).map((a) => a.site).filter(Boolean))] as string[];
  const directions = [...new Set((data?.rows ?? []).map((r) => r.direction).filter(Boolean))] as string[];
  const orderLabel = (id: number | null) => {
    if (!id) return "Без заказа (задания цеха)";
    const o = orderBy.get(id);
    return o ? `№${o.id} ${o.name}` : `№${id}`;
  };

  // ── Участки ──
  const areaRows = areas.map((a) => {
    const rs = rows.filter((r) => r.area === a.code);
    const s = sum(rs);
    return {
      key: a.code,
      area: a,
      ...s,
      orders: new Set(rs.filter((r) => left(r) > 0).map((r) => r.order_id ?? NO_ORDER)).size,
      days: a.per_day ? s.left / a.per_day : null,
    };
  });
  const bottleneck = (() => {
    const withLeft = areaRows.filter((r) => r.left > 0);
    if (!withLeft.length) return null;
    const byDays = withLeft.filter((r) => r.days != null);
    if (byDays.length) return byDays.reduce((a, b) => (b.days! > a.days! ? b : a)).key;
    return withLeft.reduce((a, b) => (b.left > a.left ? b : a)).key;
  })();
  const total = sum(rows);

  // ── Заказы × участки ──
  const matrixOrders = useMemo(() => {
    const ids = [...new Set(rows.map((r) => r.order_id ?? NO_ORDER))];
    const ship = (id: number) => orderBy.get(id)?.ship_date ?? "9999";
    return ids
      .map((id) => ({ id, s: sum(rows.filter((r) => (r.order_id ?? NO_ORDER) === id)) }))
      .filter((o) => !hideDone || o.s.left > 0)
      .sort((a, b) => (a.id === NO_ORDER ? 1 : b.id === NO_ORDER ? -1 : ship(a.id).localeCompare(ship(b.id)) || a.id - b.id));
  }, [rows, orderBy, hideDone]);
  const cell = (orderId: number, area: string) => {
    const rs = rows.filter((r) => (r.order_id ?? NO_ORDER) === orderId && r.area === area);
    return rs.length ? sum(rs) : null;
  };

  // ── По участку ──
  const sheetArea = areaParam && areaBy.has(areaParam) ? areaParam : areas[0]?.code;
  const [grouped, setGrouped] = useState<"rows" | "position">("rows");
  const sheetRows = rows
    .filter((r) => r.area === sheetArea && (orderParam == null || String(r.order_id ?? NO_ORDER) === orderParam))
    .filter((r) => !hideDone || left(r) > 0)
    .sort(
      (a, b) =>
        (orderBy.get(a.order_id ?? -1)?.ship_date ?? "9999").localeCompare(orderBy.get(b.order_id ?? -1)?.ship_date ?? "9999") ||
        a.position.localeCompare(b.position, "ru"),
    );
  const byPosition = useMemo(() => {
    const m = new Map<string, { key: string; position: string; film: string | null; program: string | null; rows: MonitorRow[] }>();
    for (const r of sheetRows) {
      // группа участка (08.10), если участок её задал, иначе — позиция
      const key = r.group ? `g|${r.group}` : `${r.position}|${r.film ?? ""}|${r.program ?? ""}`;
      if (!m.has(key)) m.set(key, { key, position: r.group ?? r.position, film: r.group ? null : r.film, program: r.group ? null : r.program, rows: [] });
      m.get(key)!.rows.push(r);
    }
    return [...m.values()].map((g) => ({ ...g, ...sum(g.rows), orders: new Set(g.rows.map((r) => r.order_id ?? NO_ORDER)).size }));
  }, [sheetRows]);

  const progressCell = (s: Sum) => (
    <Tooltip title={`сделано ${r2(s.done)} из ${r2(s.plan)}${s.defect ? `, брак ${r2(s.defect)}` : ""}`}>
      <div style={{ minWidth: 90 }}>
        <span style={{ color: cellColor(pct(s.done, s.plan), s.done > 0), fontWeight: 500 }}>
          {r2(s.done)} / {r2(s.plan)}
        </span>
        {s.defect > 0 && <span style={{ color: "#cf1322", fontSize: 12 }}> брак {r2(s.defect)}</span>}
        <Progress percent={pct(s.done, s.plan)} size="small" showInfo={false} strokeColor={cellColor(pct(s.done, s.plan), s.done > 0)} />
      </div>
    </Tooltip>
  );

  const exportAll = () => {
    const areaName = (code: string) => areaBy.get(code)?.name ?? code;
    exportBook(`Монитор производства ${dayjs().format("DD.MM.YYYY HH-mm")}`, [
      {
        name: "Участки",
        columns: [
          { key: "area", header: "Участок" },
          { key: "site", header: "Площадка" },
          { key: "plan", header: "План, шт" },
          { key: "done", header: "Сделано, шт" },
          { key: "defect", header: "Брак, шт" },
          { key: "left", header: "Осталось, шт" },
          { key: "pct", header: "Готовность, %" },
          { key: "orders", header: "Заказов в работе" },
          { key: "days", header: "Дней на остаток" },
        ],
        rows: areaRows.map((r) => ({
          area: r.area.name, site: r.area.site ?? "", plan: r2(r.plan), done: r2(r.done), defect: r2(r.defect), left: r2(r.left),
          pct: pct(r.done, r.plan), orders: r.orders, days: r.days == null ? "" : r2(r.days),
        })),
      },
      {
        name: "Заказы × участки",
        columns: [
          { key: "order", header: "Заказ" },
          { key: "ship", header: "Отгрузка" },
          ...areas.map((a) => ({ key: a.code, header: a.name })),
          { key: "pct", header: "Итого, %" },
        ],
        rows: matrixOrders.map((o) => ({
          order: orderLabel(o.id),
          ship: dm(orderBy.get(o.id)?.ship_date ?? null),
          ...Object.fromEntries(areas.map((a) => {
            const c = cell(o.id, a.code);
            return [a.code, c ? `${r2(c.done)} / ${r2(c.plan)}` : ""];
          })),
          pct: pct(o.s.done, o.s.plan),
        })),
      },
      {
        name: "Все строки",
        columns: [
          { key: "area", header: "Участок" },
          { key: "order", header: "Заказ" },
          { key: "invoice", header: "Счёт" },
          { key: "position", header: "Позиция" },
          { key: "film", header: "Плёнка" },
          { key: "program", header: "Программа" },
          { key: "plan", header: "План" },
          { key: "good", header: "Сделано" },
          { key: "defect", header: "Брак" },
          { key: "left", header: "Осталось" },
          { key: "term", header: "Срок по плану" },
        ],
        rows: rows.map((r) => ({
          area: areaName(r.area), order: orderLabel(r.order_id), invoice: r.invoice_no ?? "", position: r.position, film: r.film ?? "",
          program: r.program ?? "", plan: r.plan, good: r.good, defect: r.defect, left: left(r),
          term: r.date_from ? `${dm(r.date_from)}${r.date_to && r.date_to !== r.date_from ? `–${dm(r.date_to)}` : ""}` : "",
        })),
      },
    ]);
  };

  const areaTitle = (a: MonitorArea) => (
    <div style={{ whiteSpace: "normal", minWidth: 80 }}>
      {a.name}
      {a.site && <div style={{ fontSize: 11, fontWeight: 400, color: "#8c8c8c" }}>{a.site}</div>}
    </div>
  );

  return (
    <Card
      title="Монитор производства"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} loading={q.isFetching} onClick={() => q.refetch()} />
          <Button icon={<DownloadOutlined />} disabled={!data} onClick={exportAll}>
            Выгрузить в Excel
          </Button>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="Направление"
          style={{ width: 190 }}
          value={direction}
          onChange={setDirection}
          options={directions.map((d) => ({ value: d, label: DIRECTIONS[d] ?? d }))}
        />
        <Select allowClear placeholder="Площадка" style={{ width: 160 }} value={site} onChange={setSite} options={sites.map((s) => ({ value: s, label: s }))} />
        <Select
          mode="multiple"
          allowClear
          placeholder="Заказы — все"
          style={{ minWidth: 260, maxWidth: 520 }}
          value={orderIds}
          onChange={setOrderIds}
          optionFilterProp="label"
          maxTagCount="responsive"
          options={[
            ...(data?.orders ?? []).map((o) => ({ value: o.id, label: `${orderLabel(o.id)}${o.ship_date ? ` · отгрузка ${dm(o.ship_date)}` : ""}` })),
            ...((data?.rows ?? []).some((r) => !r.order_id) ? [{ value: NO_ORDER, label: orderLabel(null) }] : []),
          ]}
        />
        <Space size={6}>
          <Switch size="small" checked={hideDone} onChange={setHideDone} />
          <Typography.Text>скрыть сделанное</Typography.Text>
        </Space>
        <Typography.Text type="secondary">
          Всего: сделано {r2(total.done)} из {r2(total.plan)} шт ({pct(total.done, total.plan)}%), осталось {r2(total.left)}
          {total.defect ? `, брак ${r2(total.defect)}` : ""}
        </Typography.Text>
      </Space>

      <Tabs
        activeKey={tab}
        onChange={(k) => go({ tab: k })}
        items={[
          {
            key: "areas",
            label: "Участки",
            children: (
              <Table
                size="small"
                loading={q.isLoading}
                pagination={false}
                dataSource={areaRows.filter((r) => !hideDone || r.left > 0)}
                scroll={{ x: "max-content" }}
                onRow={(r) => ({ onClick: () => go({ tab: "area", area: r.key, order: undefined }), style: { cursor: "pointer" } })}
                locale={{ emptyText: "Открытых заданий нет" }}
                columns={[
                  {
                    title: "Участок",
                    render: (_, r) => (
                      <Space>
                        <b>{r.area.name}</b>
                        {r.key === bottleneck && <Tag color="red">узкое место</Tag>}
                      </Space>
                    ),
                  },
                  { title: "Площадка", render: (_, r) => r.area.site ?? "—" },
                  { title: "Готовность", width: 220, render: (_, r) => progressCell(r) },
                  { title: "Осталось, шт", align: "right", render: (_, r) => <b>{r2(r.left)}</b> },
                  { title: "Строк в работе", align: "right", dataIndex: "open" },
                  { title: "Заказов в работе", align: "right", dataIndex: "orders" },
                  {
                    title: <Tooltip title="Остаток ÷ мощность участка в день (задаётся в «Участки и линии»)">Дней на остаток</Tooltip>,
                    align: "right",
                    render: (_, r) => (r.days == null ? <Typography.Text type="secondary">мощность не задана</Typography.Text> : r2(r.days)),
                  },
                  { title: "Последний отчёт", render: (_, r) => (r.last ? dayjs(r.last).format("DD.MM HH:mm") : "—") },
                ]}
              />
            ),
          },
          {
            key: "matrix",
            label: "Заказы × участки",
            children: (
              <Table
                size="small"
                bordered
                loading={q.isLoading}
                pagination={false}
                rowKey="id"
                dataSource={matrixOrders}
                scroll={{ x: "max-content", y: "calc(100vh - 330px)" }}
                locale={{ emptyText: "Открытых заданий нет" }}
                columns={[
                  {
                    title: "Заказ",
                    fixed: "left",
                    width: 240,
                    render: (_, o) => (
                      <div style={{ whiteSpace: "normal" }}>
                        {o.id === NO_ORDER ? orderLabel(null) : <Link to={`/production-orders/${o.id}`}>{orderLabel(o.id)}</Link>}
                        {orderBy.get(o.id)?.ship_date && (
                          <div style={{ fontSize: 12, color: "#8c8c8c" }}>отгрузка {dm(orderBy.get(o.id)!.ship_date)}</div>
                        )}
                      </div>
                    ),
                  },
                  {
                    title: "Итого",
                    fixed: "left",
                    width: 110,
                    render: (_, o) => <b style={{ color: cellColor(pct(o.s.done, o.s.plan), o.s.done > 0) }}>{pct(o.s.done, o.s.plan)}%</b>,
                  },
                  ...areas.map((a) => ({
                    title: areaTitle(a),
                    key: a.code,
                    render: (_: unknown, o: { id: number }) => {
                      const c = cell(o.id, a.code);
                      if (!c) return null;
                      return (
                        <div style={{ cursor: "pointer" }} onClick={() => go({ tab: "area", area: a.code, order: String(o.id) })}>
                          {progressCell(c)}
                        </div>
                      );
                    },
                  })),
                ]}
              />
            ),
          },
          {
            key: "area",
            label: "По участку",
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Space wrap>
                  <Select
                    style={{ width: 280 }}
                    value={sheetArea}
                    onChange={(v) => go({ area: v, order: undefined })}
                    options={areas.map((a) => ({ value: a.code, label: `${a.name}${a.site ? ` · ${a.site}` : ""}` }))}
                  />
                  {orderParam != null && (
                    <Tag closable onClose={() => go({ order: undefined })}>
                      {orderLabel(Number(orderParam) || null)}
                    </Tag>
                  )}
                  <Segmented
                    value={grouped}
                    onChange={(v) => setGrouped(v as "rows" | "position")}
                    options={[
                      { value: "rows", label: "По строкам заказов" },
                      { value: "position", label: "Сводно (по группам участка)" },
                    ]}
                  />
                </Space>
                {grouped === "rows" ? (
                  <Table<MonitorRow>
                    size="small"
                    rowKey="task_line_id"
                    loading={q.isLoading}
                    dataSource={sheetRows}
                    pagination={{ pageSize: 100, hideOnSinglePage: true }}
                    scroll={{ x: "max-content" }}
                    locale={{ emptyText: "На участке нет строк в работе" }}
                    columns={[
                      {
                        title: "Заказ",
                        render: (_, r) => (
                          <div style={{ whiteSpace: "normal", maxWidth: 220 }}>
                            {r.order_id ? <Link to={`/production-orders/${r.order_id}`}>{orderLabel(r.order_id)}</Link> : orderLabel(null)}
                            {r.order_id && orderBy.get(r.order_id)?.ship_date && (
                              <div style={{ fontSize: 12, color: "#8c8c8c" }}>отгрузка {dm(orderBy.get(r.order_id)!.ship_date)}</div>
                            )}
                          </div>
                        ),
                      },
                      { title: "Счёт", render: (_, r) => r.invoice_no ?? "" },
                      { title: "Позиция", render: (_, r) => <div style={{ whiteSpace: "normal", maxWidth: 380 }}>{r.position}</div> },
                      ...(sheetRows.some((r) => r.film) ? [{ title: "Плёнка", render: (_: unknown, r: MonitorRow) => r.film ?? "" }] : []),
                      ...(sheetRows.some((r) => r.program) ? [{ title: "Программа", render: (_: unknown, r: MonitorRow) => r.program ?? "" }] : []),
                      { title: "Готовность", width: 200, render: (_, r) => progressCell(sum([r])) },
                      {
                        title: "Осталось",
                        align: "right" as const,
                        render: (_, r) => (r.closed ? <Tag>закрыто</Tag> : <b>{r2(left(r))}</b>),
                      },
                      {
                        title: "Срок по плану",
                        render: (_, r) => {
                          if (!r.date_from) return "—";
                          const late = left(r) > 0 && r.date_to && dayjs(r.date_to).isBefore(dayjs(), "day");
                          return (
                            <span style={{ color: late ? "#cf1322" : undefined }}>
                              {dm(r.date_from)}
                              {r.date_to && r.date_to !== r.date_from ? `–${dm(r.date_to)}` : ""}
                            </span>
                          );
                        },
                      },
                      { title: "Последний отчёт", render: (_, r) => (r.last_report ? dayjs(r.last_report).format("DD.MM HH:mm") : "—") },
                    ]}
                  />
                ) : (
                  <Table
                    size="small"
                    rowKey="key"
                    loading={q.isLoading}
                    dataSource={byPosition}
                    pagination={{ pageSize: 100, hideOnSinglePage: true }}
                    scroll={{ x: "max-content" }}
                    locale={{ emptyText: "На участке нет строк в работе" }}
                    columns={[
                      { title: "Позиция", render: (_, g) => <div style={{ whiteSpace: "normal", maxWidth: 420 }}>{g.position}</div> },
                      ...(byPosition.some((g) => g.film) ? [{ title: "Плёнка", render: (_: unknown, g: (typeof byPosition)[number]) => g.film ?? "" }] : []),
                      ...(byPosition.some((g) => g.program)
                        ? [{ title: "Программа", render: (_: unknown, g: (typeof byPosition)[number]) => g.program ?? "" }]
                        : []),
                      { title: "Заказов", align: "right" as const, dataIndex: "orders" },
                      { title: "Готовность", width: 200, render: (_, g) => progressCell(g) },
                      { title: "Осталось", align: "right" as const, render: (_, g) => <b>{r2(g.left)}</b> },
                    ]}
                  />
                )}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
