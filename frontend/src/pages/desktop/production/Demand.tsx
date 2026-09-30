import { useMemo } from "react";
import { Card, Empty, Space, Table, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../../auth/AuthContext";
import { listProductionOrders } from "../../../api/productionOrders";
import PfDemand from "./PfDemand";
import { BlanksDemandTab } from "../Blanks";

type Tab = "pf" | "film" | "components";

/** Потребность — «чего не хватает и что запустить» одним экраном:
 * п/ф (создать задания), плёнка (что резать заранее под открытые задания)
 * и комплектующие (по открытым заказам). Каждый видит свои вкладки по
 * правам: начальник цеха — п/ф и комплектующие, кладовщик — плёнку. */
export default function Demand() {
  const { user } = useAuth();
  const has = (...codes: string[]) => !!user?.is_superuser || codes.some((c) => user?.permissions.includes(c));
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(has("production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view")
      ? [{ key: "pf" as Tab, label: "П/ф", children: <PfDemand /> }]
      : []),
    ...(has("units.issue", "production_tasks.manage", "production_tasks.view")
      ? [{ key: "film" as Tab, label: "Плёнка", children: <BlanksDemandTab /> }]
      : []),
    ...(has("production_tasks.manage", "production_tasks.view")
      ? [{ key: "components" as Tab, label: "Комплектующие", children: <ComponentsDemand /> }]
      : []),
  ];
  const wanted = params.get("tab") as Tab | null;
  const active = tabs.some((t) => t.key === wanted) ? wanted! : tabs[0]?.key;
  return (
    <Card>
      <Typography.Title level={4}>Потребность</Typography.Title>
      <Tabs
        activeKey={active}
        onChange={(k) => {
          const p = new URLSearchParams(params);
          p.set("tab", k);
          setParams(p, { replace: true });
        }}
        items={tabs}
      />
    </Card>
  );
}

type ComponentRow = { key: string; name: string; unit: string; total: number; left: number; orders: { id: number; name: string; left: number }[] };

/** Комплектующие по открытым заказам: сколько нужно всего и сколько ещё
 * по недоделанному (по позициям заказа: на 1 шт × (заказано − готово)).
 * Складского учёта комплектующих пока нет — только потребность. */
function ComponentsDemand() {
  const q = useQuery({ queryKey: ["production-orders", "demand"], queryFn: () => listProductionOrders(false) });
  const rows = useMemo(() => {
    const m = new Map<string, ComponentRow>();
    for (const o of q.data ?? []) {
      if (o.status === "closed") continue;
      for (const l of o.lines) {
        const leftQty = Math.max(0, l.quantity - l.done);
        for (const c of l.components) {
          const key = `${c.item_id}:${c.unit}`;
          const r = m.get(key) ?? { key, name: c.name, unit: c.unit, total: 0, left: 0, orders: [] };
          const left = c.per_unit * leftQty;
          r.total += c.total;
          r.left += left;
          const prev = r.orders.find((x) => x.id === o.id);
          if (prev) prev.left += left;
          else r.orders.push({ id: o.id, name: o.name, left });
          m.set(key, r);
        }
      }
    }
    return [...m.values()].sort((a, b) => b.left - a.left);
  }, [q.data]);
  const fmt = (n: number) => Math.round(n * 100) / 100;
  if (!q.isLoading && !rows.length)
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="В открытых заказах нет позиций с комплектующими (их задают в техкарте позиции)" />;
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        По открытым заказам на производство: «осталось» — на то, что ещё не сделано. Складской остаток комплектующих система
        пока не ведёт.
      </Typography.Paragraph>
      <Table<ComponentRow>
        size="small"
        rowKey="key"
        loading={q.isLoading}
        pagination={false}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "Комплектующее", dataIndex: "name" },
          { title: "Осталось", render: (_, r) => <b>{`${fmt(r.left)} ${r.unit}`}</b>, sorter: (a, b) => a.left - b.left },
          { title: "Всего по заказам", render: (_, r) => `${fmt(r.total)} ${r.unit}` },
          {
            title: "Заказы",
            render: (_, r) => (
              <Space size={4} wrap>
                {r.orders.map((o) => (
                  <Tag key={o.id}>
                    №{o.id} «{o.name}» · {fmt(o.left)}
                  </Tag>
                ))}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
