import { useMemo } from "react";
import { Button, Empty, Progress, Space, Tag, Tooltip, Typography, theme } from "antd";
import dayjs from "dayjs";
import type { MonitorArea, MonitorOrder, MonitorRow } from "../../../../api/productionMonitor";
import GroupedTable from "../../../../components/GroupedTable";
import QuickReport from "./QuickReport";

const r2 = (v: number) => Math.round(v * 100) / 100;
const dm = (s: string | null | undefined) => (s ? dayjs(s).format("DD.MM") : "");
const leftOf = (r: MonitorRow) => (r.closed ? 0 : Math.max(0, r.plan - r.good));
const doneOf = (r: MonitorRow) => (r.closed ? r.plan : Math.min(r.good, r.plan));
const posOf = (r: MonitorRow) => (r.part_id == null && (r.series || r.size) ? [r.series, r.size, r.color].filter(Boolean).join(" · ") : r.position);

/** «Задания цехов» (21.10): плитки участков (по площадкам) — выбрали участок,
 * ниже только его строки по всем заказам, с отчётом прямо в строке (участки
 * без рулона и дневного плана) или переходом в задание. */
export default function AreasView({
  rows,
  orders,
  areas,
  area,
  onArea,
  hideDone,
  onOpenTask,
}: {
  rows: MonitorRow[];
  orders: MonitorOrder[];
  areas: MonitorArea[];
  area: string | undefined;
  onArea: (code: string) => void;
  hideDone: boolean;
  onOpenTask: (id: number) => void;
}) {
  const { token } = theme.useToken();
  const orderName = useMemo(() => new Map(orders.map((o) => [o.id, `№${o.id} «${o.name}»`])), [orders]);
  const stats = useMemo(() => {
    const m = new Map<string, { plan: number; done: number; left: number; open: number; quick: boolean }>();
    for (const r of rows) {
      const s = m.get(r.area) ?? { plan: 0, done: 0, left: 0, open: 0, quick: false };
      s.plan += r.plan;
      s.done += doneOf(r);
      s.left += leftOf(r);
      if (leftOf(r) > 0) s.open += 1;
      s.quick ||= !!r.quick;
      m.set(r.area, s);
    }
    return m;
  }, [rows]);
  const used = areas.filter((a) => stats.has(a.code));
  const sites = [...new Set(used.map((a) => a.site ?? "Без площадки"))];
  const cur = area && stats.has(area) ? area : used[0]?.code;
  const data = useMemo(
    () => rows.filter((r) => r.area === cur && (!hideDone || leftOf(r) > 0)),
    [rows, cur, hideDone],
  );
  if (!used.length) return <Empty description="Открытых заданий нет" />;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {sites.map((site) => (
        <div key={site} style={{ display: "grid", gap: 6 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase" }}>
            {site}
          </Typography.Text>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
            {used
              .filter((a) => (a.site ?? "Без площадки") === site)
              .map((a) => {
                const s = stats.get(a.code)!;
                const on = a.code === cur;
                const pct = s.plan ? Math.round((s.done / s.plan) * 100) : 100;
                return (
                  <button
                    key={a.code}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onArea(a.code)}
                    style={{
                      textAlign: "left", padding: "8px 10px", borderRadius: 8, cursor: "pointer", font: "inherit", color: "inherit",
                      border: `1px solid ${on ? token.colorPrimary : token.colorBorderSecondary}`,
                      background: on ? token.colorPrimaryBg : token.colorBgContainer,
                    }}
                  >
                    <div style={{ fontWeight: on ? 600 : 500 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                      осталось {r2(s.left)} шт · строк {s.open}
                      {!s.quick && <Tag style={{ marginLeft: 6, fontSize: 11 }}>отчёт в задании</Tag>}
                    </div>
                    <Progress percent={pct} size="small" showInfo={false} strokeColor={pct >= 100 ? token.colorSuccess : token.colorPrimary} />
                  </button>
                );
              })}
          </div>
        </div>
      ))}
      <GroupedTable<MonitorRow>
        key={cur}
        storageKey="monitor.area"
        dims={[
          { key: "order", label: "Заказ", value: (r) => (r.order_id != null ? orderName.get(r.order_id) ?? `№${r.order_id}` : r.task_name ?? "") },
          { key: "invoice", label: "Счёт", value: (r) => r.invoice_no ?? "" },
          { key: "op", label: "Операция", value: (r) => r.operation ?? "" },
          { key: "pos", label: "Позиция", value: (r) => posOf(r) },
        ]}
        defaultDims={["order"]}
        labelColumn="pos"
        size="small"
        rowKey={(r) => String(r.task_line_id)}
        dataSource={data}
        pagination={false}
        scroll={{ x: "max-content", y: "calc(100vh - 420px)" }}
        exportTitle={`Монитор: ${used.find((a) => a.code === cur)?.name ?? cur}`}
        columns={[
          {
            key: "pos",
            title: "Позиция",
            width: 300,
            sortValue: posOf,
            render: (_, r) => (
              <div style={{ whiteSpace: "normal" }}>
                <div>{posOf(r)}</div>
                {r.part_id == null && r.source && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {r.source}
                  </Typography.Text>
                )}
              </div>
            ),
          },
          { key: "invoice", title: "Счёт", width: 100, sortValue: (r) => r.invoice_no ?? "", render: (_, r) => r.invoice_no ?? "" },
          { key: "op", title: "Операция", width: 130, sortValue: (r) => r.operation ?? "", render: (_, r) => r.operation ?? "" },
          {
            key: "plan",
            title: "План",
            width: 70,
            align: "right",
            sortValue: (r) => r.plan,
            render: (_, r) => r2(r.plan),
            groupRender: (rs) => r2(rs.reduce((s, r) => s + r.plan, 0)),
          },
          {
            key: "done",
            title: "Сделано",
            width: 80,
            align: "right",
            sortValue: (r) => doneOf(r),
            render: (_, r) => (
              <span>
                {r2(r.good)}
                {r.defect > 0 && <Typography.Text type="danger" style={{ fontSize: 11 }}> б{r2(r.defect)}</Typography.Text>}
              </span>
            ),
            groupRender: (rs) => r2(rs.reduce((s, r) => s + doneOf(r), 0)),
          },
          {
            key: "left",
            title: "Осталось",
            width: 80,
            align: "right",
            sortValue: leftOf,
            render: (_, r) => (r.closed ? <Tag>закрыто</Tag> : leftOf(r) > 0 ? <b>{r2(leftOf(r))}</b> : <Tag color="green">готово</Tag>),
            groupRender: (rs) => <b>{r2(rs.reduce((s, r) => s + leftOf(r), 0))}</b>,
          },
          {
            key: "date",
            title: "Срок",
            width: 90,
            sortValue: (r) => r.date_from ?? "",
            render: (_, r) => (r.date_from ? (r.date_to && r.date_to !== r.date_from ? `${dm(r.date_from)}–${dm(r.date_to)}` : dm(r.date_from)) : ""),
          },
          {
            key: "report",
            title: "Отчёт",
            width: 420,
            render: (_, r) =>
              r.quick && leftOf(r) >= 0 ? (
                <QuickReport row={r} compact />
              ) : (
                <Tooltip title={r.closed ? "Строка закрыта" : "Нужен рулон или дневной план — отчёт в задании"}>
                  <Button size="small" onClick={() => onOpenTask(r.task_id)}>
                    Задание №{r.task_id}
                  </Button>
                </Tooltip>
              ),
          },
        ]}
      />
    </Space>
  );
}
