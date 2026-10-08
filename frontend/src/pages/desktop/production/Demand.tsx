import { useState } from "react";
import { Card, Empty, Space, Switch, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../../auth/AuthContext";
import { listMaterialDemand, type MaterialDemandRow } from "../../../api/materialStock";
import { normsLabel } from "../../../utils/normatives";
import PfDemand from "./PfDemand";
import { BlanksDemandTab } from "../Blanks";
import ResponsiveTable from "../../../components/ResponsiveTable";

type Tab = "pf" | "film" | "components";

/** Потребность — «чего не хватает и что запустить» одним экраном:
 * п/ф (создать задания), плёнка (что резать заранее под открытые задания)
 * и материалы (что заказать). Пополнение везде по одним нормативам позиции
 * (08.10). Каждый видит свои вкладки по правам. */
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
    ...(has("production_tasks.manage", "production_tasks.view", "materials.manage", "purchasing.manage", "units.receive")
      ? [{ key: "components" as Tab, label: "Материалы", children: <MaterialsDemand /> }]
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

/** Материалы (МДФ, пенопласт, клей…) — по тем же нормативам, что плёнка и
 * п/ф (08.10): нужно = открытые операции (ещё не сделанное × состав на этой
 * операции) + мин. остаток; есть = остаток на складе; заказать — не меньше
 * мин. партии, вверх до кратного. Комплектующие-п/ф (каркас, панели) — на
 * вкладке «П/ф». */
function MaterialsDemand() {
  const q = useQuery({ queryKey: ["material-demand"], queryFn: listMaterialDemand });
  const [onlyShort, setOnlyShort] = useState(true);
  const rows = (q.data ?? []).filter((r) => !onlyShort || r.to_order > 0 || r.demand > 0);
  const fmt = (n: number) => Math.round(n * 100) / 100;
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Space wrap>
        <Typography.Text type="secondary">
          Нужно — по открытым операциям заданий и заказов плюс мин. остаток; заказать — с учётом мин. партии и кратности (задаются в
          карточке позиции → «Изменить»). Детали п/ф — на вкладке «П/ф».
        </Typography.Text>
        <Space size={6}>
          <Switch size="small" checked={onlyShort} onChange={setOnlyShort} />
          <Typography.Text>только с потребностью</Typography.Text>
        </Space>
      </Space>
      {!q.isLoading && !rows.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Материалов к пополнению нет" />
      ) : (
        <ResponsiveTable<MaterialDemandRow>
          exportTitle="Потребность в материалах"
          size="small"
          rowKey="item_id"
          loading={q.isLoading}
          pagination={false}
          dataSource={rows}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Материал", render: (_, r) => <Link to={`/item/${r.item_id}`}>{r.name}</Link> },
            { title: "Остаток", render: (_, r) => <span style={{ color: r.stock < 0 ? "#cf1322" : undefined }}>{`${fmt(r.stock)} ${r.unit}`}</span> },
            { title: "По заданиям", render: (_, r) => (r.demand ? `${fmt(r.demand)} ${r.unit}` : "—") },
            { title: "Нормативы", render: (_, r) => normsLabel(r.min_stock, r.min_batch, r.batch_multiple) },
            { title: "Не хватает", render: (_, r) => (r.shortage ? `${fmt(r.shortage)} ${r.unit}` : "—") },
            {
              title: "Заказать",
              sorter: (a, b) => a.to_order - b.to_order,
              render: (_, r) => (r.to_order > 0 ? <Tag color="orange">{`${fmt(r.to_order)} ${r.unit}`}</Tag> : <Tag color="green">хватает</Tag>),
            },
            {
              title: "Задания",
              render: (_, r) => (
                <Space size={4} wrap>
                  {r.sources.slice(0, 6).map((s) => (
                    <Tag key={s.task_id}>
                      №{s.task_id} {s.task_name} · {fmt(s.qty)}
                    </Tag>
                  ))}
                  {r.sources.length > 6 && <Typography.Text type="secondary">ещё {r.sources.length - 6}</Typography.Text>}
                </Space>
              ),
            },
          ]}
        />
      )}
    </Space>
  );
}
