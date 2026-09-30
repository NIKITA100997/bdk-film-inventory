import { useMemo, useState } from "react";
import { Card, Checkbox, Col, Empty, Grid, Input, Progress, Row, Segmented, Select, Space, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { listProductionTasks, type ProductionTask } from "../../../api/production";
import { listProductionOrders } from "../../../api/productionOrders";
import { listAreas } from "../../../api/areas";
import { useAuth } from "../../../auth/AuthContext";
import TaskCardDrawer, { TaskCardPanel } from "./TaskCardDrawer";

type Filter = "all" | "film" | "pf" | "wait" | "late";

const isFilm = (t: ProductionTask) => t.lines.some((l) => l.material !== null);
const isPf = (t: ProductionTask) => t.for_task_id != null || (!isFilm(t) && t.lines.some((l) => l.operation_name != null));
const progress = (t: ProductionTask) => {
  const plan = t.lines.reduce((s, l) => s + l.quantity_pieces, 0);
  const done = t.lines.reduce((s, l) => s + Math.min(l.produced_good_pieces, l.quantity_pieces), 0);
  return { plan, done };
};
const ready = (t: ProductionTask) => t.lines.every((l) => l.production_closed || l.remaining_pieces <= 0);

/** Задания цеха для начальника: список с отборами слева, карточка задания
 * справа (на узком экране — поверх). Отборы — по тому, что реально
 * спрашивают в цеху: что в плёнке, что п/ф, какая окутка ждёт свой п/ф,
 * какие задания в заказах, которые не успевают к отгрузке. */
export default function TasksBoard() {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const canReport = canManage || !!user?.permissions.includes("production_tasks.report");
  const screens = Grid.useBreakpoint();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [area, setArea] = useState<string | null>(user?.area ?? null);
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<number | null>(Number(params.get("task")) || null);

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const ordersQuery = useQuery({ queryKey: ["production-orders", "board"], queryFn: () => listProductionOrders(false) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaName = (c: string) => areasQuery.data?.find((a) => a.code === c)?.name ?? c;

  const all = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const lateOrders = useMemo(() => new Set((ordersQuery.data ?? []).filter((o) => o.plan_late).map((o) => o.id)), [ordersQuery.data]);
  const pfByTask = useMemo(() => {
    const m = new Map<number, ProductionTask[]>();
    for (const t of all) if (t.for_task_id != null) m.set(t.for_task_id, [...(m.get(t.for_task_id) ?? []), t]);
    return m;
  }, [all]);
  const waitsPf = (t: ProductionTask) => (pfByTask.get(t.id) ?? []).some((p) => p.is_active && !ready(p));
  const late = (t: ProductionTask) => t.production_order_id != null && lateOrders.has(t.production_order_id);

  const FILTERS: [Filter, string, (t: ProductionTask) => boolean][] = [
    ["all", "Все", () => true],
    ["film", "С плёнкой", isFilm],
    ["pf", "П/ф", isPf],
    ["wait", "Ждёт п/ф", waitsPf],
    ["late", "Не успевает", late],
  ];
  const base = all.filter((t) => (archived || t.is_active) && (!area || t.area === area));
  const needle = q.trim().toLowerCase();
  const rows = base
    .filter(FILTERS.find((f) => f[0] === filter)![2])
    .filter(
      (t) =>
        !needle ||
        `${t.id} ${t.name ?? ""} ${t.product_model_name ?? ""} ${t.production_order_name ?? ""} ${t.lines.map((l) => l.part_name ?? "").join(" ")}`
          .toLowerCase()
          .includes(needle),
    );
  const wide = !!screens.lg;
  const current = selected ?? (wide ? rows[0]?.id ?? null : null);

  const list = (
    <Card size="small" styles={{ body: { padding: 0 } }}>
      <Space direction="vertical" style={{ width: "100%", padding: 12 }}>
        <Input.Search allowClear placeholder="Номер, деталь, заказ" value={q} onChange={(e) => setQ(e.target.value)} />
        <Space wrap size={[6, 6]}>
          {!user?.area && (
            <Select
              allowClear
              placeholder="Все участки"
              style={{ width: 200 }}
              value={area ?? undefined}
              onChange={(v) => setArea(v ?? null)}
              options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
            />
          )}
          <Checkbox checked={archived} onChange={(e) => setArchived(e.target.checked)}>
            архив
          </Checkbox>
        </Space>
        <Segmented
          block={!wide}
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          options={FILTERS.map(([k, label, fn]) => ({ value: k, label: `${label} ${base.filter(fn).length}` }))}
          style={{ flexWrap: "wrap" }}
        />
      </Space>
      <div style={{ maxHeight: wide ? "calc(100vh - 330px)" : undefined, overflowY: "auto", borderTop: "1px solid rgba(0,0,0,.06)" }}>
        {rows.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tasksQuery.isLoading ? "Загрузка…" : "Ничего не подходит под отбор"} style={{ padding: 24 }} />
        ) : (
          rows.map((t) => {
            const { plan, done } = progress(t);
            const active = t.id === current;
            return (
              <button
                key={t.id}
                onClick={() => setSelected(t.id)}
                style={{
                  display: "grid",
                  gap: 4,
                  width: "100%",
                  textAlign: "left",
                  border: 0,
                  borderBottom: "1px solid rgba(0,0,0,.06)",
                  background: active ? "rgba(200,118,47,.12)" : "transparent",
                  padding: "10px 12px",
                  cursor: "pointer",
                  font: "inherit",
                  color: "inherit",
                }}
              >
                <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase" }}>
                  {isPf(t) ? "П/ф" : isFilm(t) ? "С плёнкой" : "Операции"} · {areaName(t.area)}
                </Typography.Text>
                <Space style={{ justifyContent: "space-between", width: "100%" }} align="start">
                  <Typography.Text strong>
                    №{t.id} {t.name ?? t.product_model_name ?? "Задание"}
                  </Typography.Text>
                  <Space size={4}>
                    {!t.is_active && <Tag style={{ marginInlineEnd: 0 }}>архив</Tag>}
                    {late(t) && (
                      <Tag color="red" style={{ marginInlineEnd: 0 }}>
                        не успевает
                      </Tag>
                    )}
                  </Space>
                </Space>
                <Space size={8} wrap style={{ fontSize: 12.5 }}>
                  <Typography.Text type="secondary">
                    {t.for_task_id ? `для №${t.for_task_id}` : t.production_order_id ? `заказ №${t.production_order_id}` : "без заказа"}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {done} из {plan}
                  </Typography.Text>
                  {waitsPf(t) && <Typography.Text type="warning">ждёт п/ф</Typography.Text>}
                </Space>
                <Progress percent={plan ? Math.round((done / plan) * 100) : 0} size="small" showInfo={false} style={{ margin: 0 }} />
              </button>
            );
          })
        )}
      </div>
    </Card>
  );

  if (!wide)
    return (
      <>
        {list}
        <TaskCardDrawer taskId={selected} onClose={() => setSelected(null)} canManage={canManage} canReport={canReport} />
      </>
    );
  return (
    <Row gutter={16} align="top">
      <Col span={9}>{list}</Col>
      <Col span={15}>
        <Card size="small" styles={{ body: { padding: 0 } }}>
          {current != null ? (
            <TaskCardPanel taskId={current} canManage={canManage} canReport={canReport} />
          ) : (
            <Empty style={{ padding: 40 }} description="Выберите задание слева" />
          )}
        </Card>
      </Col>
    </Row>
  );
}
