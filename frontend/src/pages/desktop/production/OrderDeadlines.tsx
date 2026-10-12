import { useState } from "react";
import { Button, Card, DatePicker, Space, Statistic, Table, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { getDeadlines, type DeadlineRow } from "../../../api/orderControl";
import { exportToExcel } from "../../../utils/excel";

const d = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "—");
const yes = (v: boolean | null) => (v === true ? <Tag color="green">вовремя</Tag> : v === false ? <Tag color="red">с опозданием</Tag> : <Tag>ещё не</Tag>);

/** Сроки заказов (12.10, этап 4): готово и отгружено ли вовремя — по
 * обещанным датам; по менеджерам; почему переносили. */
export default function OrderDeadlines() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs().endOf("month")]);
  const q = useQuery({
    queryKey: ["deadlines", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")],
    queryFn: () => getDeadlines(range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")),
  });
  const rows = q.data?.rows ?? [];
  const shipped = rows.filter((r) => r.ship_on_time !== null);
  const onTime = shipped.filter((r) => r.ship_on_time).length;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small" title="Сроки заказов">
        <Space wrap>
          <DatePicker.RangePicker format="DD.MM.YYYY" value={range} allowClear={false} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
          <Typography.Text type="secondary">заказы с обещанной отгрузкой в периоде</Typography.Text>
          <Button
            disabled={!rows.length}
            onClick={() =>
              exportToExcel(
                `Сроки заказов ${range[0].format("DD.MM")}-${range[1].format("DD.MM.YYYY")}`,
                rows.map((r) => ({
                  ...r,
                  ready_on_time: r.ready_on_time === null ? "" : r.ready_on_time ? "да" : "нет",
                  ship_on_time: r.ship_on_time === null ? "" : r.ship_on_time ? "да" : "нет",
                })),
                [
                  { key: "order_id", header: "№" },
                  { key: "name", header: "Заказ" },
                  { key: "customer", header: "Клиент" },
                  { key: "manager", header: "Менеджер" },
                  { key: "promised_ready", header: "Обещанная готовность" },
                  { key: "ready_fact", header: "Факт готовности" },
                  { key: "ready_on_time", header: "Готово вовремя" },
                  { key: "ship_date", header: "Обещанная отгрузка" },
                  { key: "shipped_at", header: "Последняя отгрузка" },
                  { key: "ship_on_time", header: "Отгружено вовремя" },
                  { key: "moves", header: "Переносов" },
                ],
              )
            }
          >
            Excel
          </Button>
        </Space>
      </Card>
      <Space wrap size="middle">
        <Card size="small"><Statistic title="Заказов" value={rows.length} /></Card>
        <Card size="small"><Statistic title="Отгружено вовремя" value={shipped.length ? Math.round((onTime / shipped.length) * 100) : 0} suffix="%" /></Card>
        <Card size="small"><Statistic title="С опозданием" value={shipped.length - onTime} /></Card>
        <Card size="small"><Statistic title="Переносов дат" value={rows.reduce((s, r) => s + r.moves, 0)} /></Card>
      </Space>
      <Space wrap align="start" size="middle">
        <Card size="small" title="По менеджерам" style={{ minWidth: 360 }}>
          <Table
            size="small"
            rowKey="m"
            pagination={false}
            dataSource={Object.entries(q.data?.by_manager ?? {}).map(([m, v]) => ({ m, ...v }))}
            columns={[
              { title: "Менеджер", dataIndex: "m" },
              { title: "Заказов", dataIndex: "orders", align: "right" },
              { title: "Вовремя", dataIndex: "on_time", align: "right" },
              { title: "С опозданием", dataIndex: "late", align: "right" },
            ]}
          />
        </Card>
        <Card size="small" title="Причины переносов" style={{ minWidth: 320 }}>
          <Table
            size="small"
            rowKey={(r) => r[0]}
            pagination={false}
            dataSource={q.data?.reasons ?? []}
            locale={{ emptyText: "Переносов не было" }}
            columns={[
              { title: "Причина", render: (_, r) => r[0] },
              { title: "Раз", align: "right", render: (_, r) => r[1] },
            ]}
          />
        </Card>
      </Space>
      <Table<DeadlineRow>
        size="small"
        rowKey="order_id"
        loading={q.isLoading}
        pagination={{ pageSize: 50 }}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "Заказ", render: (_, r) => <Link to={`/production-orders/${r.order_id}`}>№{r.order_id} «{r.name}»</Link> },
          { title: "Клиент", dataIndex: "customer", render: (v) => v ?? "—" },
          { title: "Менеджер", dataIndex: "manager", render: (v) => v ?? "—" },
          { title: "Готовность: обещано / факт", render: (_, r) => <Space size={4}>{d(r.promised_ready)} / {d(r.ready_fact)} {yes(r.ready_on_time)}</Space> },
          { title: "Отгрузка: обещано / факт", render: (_, r) => <Space size={4}>{d(r.ship_date)} / {d(r.shipped_at)}{!r.shipped_all && r.shipped_at ? " (частично)" : ""} {yes(r.ship_on_time)}</Space> },
          { title: "Переносов", dataIndex: "moves", align: "right" },
        ]}
      />
    </Space>
  );
}
