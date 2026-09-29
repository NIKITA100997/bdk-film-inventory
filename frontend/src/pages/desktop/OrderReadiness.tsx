import { useMemo, useState } from "react";
import dayjs from "dayjs";
import { Card, Checkbox, Input, Progress, Space, Table, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getOrdersReadiness, type OrderReadiness } from "../../api/productionOrders";

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Готовность заказов для продажника: когда будет готово по плану, успевает
 * ли к отгрузке и сколько сделано по позициям — без цеховых подробностей
 * (задания, участки). План — из планировщика (сроки назад от отгрузки). */
export default function OrderReadiness() {
  const [q, setQ] = useState("");
  const [withClosed, setWithClosed] = useState(false);
  const [onlyRisk, setOnlyRisk] = useState(false);
  const query = useQuery({ queryKey: ["order-readiness", withClosed], queryFn: () => getOrdersReadiness(withClosed) });
  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return (query.data ?? []).filter(
      (o) =>
        (!needle || norm(o.name).includes(needle) || String(o.id) === needle.replace("№", "") || o.lines.some((l) => norm(l.item_name).includes(needle))) &&
        (!onlyRisk || o.plan_late || o.plan_overdue > 0),
    );
  }, [query.data, q, onlyRisk]);
  const risky = (query.data ?? []).filter((o) => o.plan_late || o.plan_overdue > 0).length;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card title="Готовность заказов">
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            Для каждого заказа в производстве: дата отгрузки, когда будет готово по плану цеха, успевает ли и сколько уже
            сделано. Раскройте строку — готовность по позициям.
          </Typography.Text>
          <Space wrap>
            <Input.Search allowClear placeholder="Заказ, № или позиция" style={{ width: 300 }} value={q} onChange={(e) => setQ(e.target.value)} />
            <Checkbox checked={onlyRisk} onChange={(e) => setOnlyRisk(e.target.checked)}>
              Только с риском{risky ? ` (${risky})` : ""}
            </Checkbox>
            <Checkbox checked={withClosed} onChange={(e) => setWithClosed(e.target.checked)}>
              С закрытыми
            </Checkbox>
          </Space>
        </Space>
      </Card>
      <Table<OrderReadiness>
        size="small"
        rowKey="id"
        loading={query.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 30, hideOnSinglePage: true }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Заказов в производстве нет" }}
        expandable={{
          expandedRowRender: (o) => (
            <Table
              size="small"
              rowKey={(_, i) => String(i)}
              pagination={false}
              dataSource={o.lines}
              columns={[
                { title: "Позиция", dataIndex: "item_name" },
                { title: "Заказано", render: (_, l) => fmt(l.quantity) },
                { title: "Готово", render: (_, l) => fmt(l.done) },
                {
                  title: "",
                  render: (_, l) => (
                    <Progress percent={l.quantity ? Math.round((l.done / l.quantity) * 100) : 0} size="small" style={{ width: 140 }} />
                  ),
                },
              ]}
            />
          ),
        }}
        columns={[
          { title: "Заказ", render: (_, o) => `№${o.id} «${o.name}»` },
          {
            title: "Отгрузка",
            sorter: (a, b) => (a.ship_date ?? "9").localeCompare(b.ship_date ?? "9"),
            render: (_, o) => (o.ship_date ? dayjs(o.ship_date).format("DD.MM.YYYY") : "—"),
          },
          {
            title: "Готово по плану",
            render: (_, o) =>
              !o.planned ? (
                <Tag>без плана</Tag>
              ) : (
                <Space size={4} wrap>
                  {o.plan_finish && <span>{dayjs(o.plan_finish).format("DD.MM.YYYY")}</span>}
                  {o.plan_late ? <Tag color="red">не успевает к отгрузке</Tag> : <Tag color="green">успевает</Tag>}
                  {o.plan_overdue > 0 && <Tag color="orange">отставание {fmt(o.plan_overdue)} шт</Tag>}
                </Space>
              ),
          },
          {
            title: "Сделано",
            render: (_, o) => (
              <Space size={8}>
                <Progress percent={o.quantity ? Math.round((o.done / o.quantity) * 100) : 0} size="small" style={{ width: 120 }} />
                <span>
                  {fmt(o.done)} из {fmt(o.quantity)}
                </span>
              </Space>
            ),
          },
          { title: "Статус", render: (_, o) => (o.status === "closed" ? <Tag>закрыт</Tag> : <Tag color="blue">в производстве</Tag>) },
        ]}
      />
    </Space>
  );
}
