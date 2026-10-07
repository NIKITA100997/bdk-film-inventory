import { Button, Progress, Space, Table, Tag, Typography } from "antd";
import { ItemChars } from "../../../components/ItemChars";
import type { OrderLine, OrderTask, ProductionOrder } from "../../../api/productionOrders";
import { SectionsView, period, type SectionItem } from "./LayoutSheets";

const pct = (a: number, b: number) => (b ? Math.round((Math.min(a, b) / b) * 100) : 0);
const color = (a: number, b: number) => (a >= b && b > 0 ? "#389e0d" : a > 0 ? "#C97A2B" : undefined);

/** «Ход» запущенного заказа (07.10) — как черновик: слева «Все строки» и
 * задания участкам, справа таблица. «Все строки» — матрица «строка ×
 * операция» (сделано из), вместо карточки на каждую строку. */
export default function OrderFlow({
  order,
  canManage,
  onOpenTask,
  onSupply,
}: {
  order: ProductionOrder;
  canManage: boolean;
  onOpenTask: (id: number) => void;
  onSupply: (t: OrderTask) => void;
}) {
  // операции в порядке маршрута (объединение по всем строкам)
  const opNames: string[] = [];
  for (const l of order.lines) {
    let prev = -1;
    for (const op of l.operations) {
      const at = opNames.indexOf(op.name);
      if (at >= 0) prev = at;
      else opNames.splice((prev += 1), 0, op.name); // после предыдущей операции этой строки
    }
  }
  const totalQty = order.lines.reduce((s, l) => s + l.quantity, 0);
  const totalDone = order.lines.reduce((s, l) => s + Math.min(l.done, l.quantity), 0);

  const matrix = (
    <Table<OrderLine>
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={order.lines}
      scroll={{ x: "max-content", y: "calc(100vh - 360px)" }}
      expandable={{
        rowExpandable: (l) => l.components.length > 0,
        expandedRowRender: (l) => (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              КОМПЛЕКТУЮЩИЕ НА ЗАКАЗ
            </Typography.Text>
            <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {l.components.map((c) => (
                <li key={c.item_id}>
                  {c.name} — {c.total} {c.unit}
                  <Typography.Text type="secondary">
                    {" "}
                    ({c.per_unit} на 1 шт{c.operation_name ? `, на «${c.operation_name}»` : ""})
                  </Typography.Text>
                </li>
              ))}
            </ul>
          </div>
        ),
      }}
      columns={[
        {
          title: "Изделие",
          fixed: "left",
          width: 320,
          render: (_, l) => (
            <div title={l.item_name}>
              <ItemChars chars={l.item_chars} name={l.item_name} strong={false} showName={false} />
              {l.invoice_no && <Tag color="purple" style={{ marginInlineEnd: 0 }}>счёт {l.invoice_no}</Tag>}
              {l.operations.length === 0 && <Typography.Text type="warning"> нет маршрута</Typography.Text>}
            </div>
          ),
        },
        { title: "Кол-во", align: "right", width: 70, render: (_, l) => l.quantity },
        ...opNames.map((name) => ({
          title: <span style={{ whiteSpace: "nowrap" }}>{name}</span>,
          key: name,
          align: "center" as const,
          render: (_: unknown, l: OrderLine) => {
            const op = l.operations.find((o) => o.name === name);
            if (!op) return <Typography.Text type="secondary">—</Typography.Text>;
            return (
              <a onClick={() => op.task_id && onOpenTask(op.task_id)} style={{ color: color(op.good, l.quantity) ?? "inherit", whiteSpace: "nowrap" }}>
                <b>{op.good}</b>/{l.quantity}
                {op.defect ? <Typography.Text type="danger"> · брак {op.defect}</Typography.Text> : null}
              </a>
            );
          },
        })),
        {
          title: "Готово",
          fixed: "right",
          width: 120,
          render: (_, l) => <Progress percent={pct(l.done, l.quantity)} size="small" format={() => `${l.done}/${l.quantity}`} />,
        },
      ]}
    />
  );

  const taskTable = (t: OrderTask) => {
    const rows = order.lines.flatMap((l) =>
      l.operations.filter((op) => op.task_id === t.id).map((op) => ({ key: `${l.id}-${op.stage_id}`, l, op })),
    );
    return (
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space wrap>
          <Button type="primary" onClick={() => onOpenTask(t.id)}>
            Открыть задание №{t.id}
          </Button>
          {canManage && t.is_active && t.with_parts && <Button onClick={() => onSupply(t)}>Обеспечение п/ф</Button>}
          <Typography.Text type="secondary">
            {t.name} · план {period(t.plan_from ?? null, t.plan_to ?? null)}
          </Typography.Text>
        </Space>
        {rows.length === 0 ? (
          <Typography.Text type="secondary">
            Строки этого задания — детали п/ф и другие позиции, не строки заказа: откройте задание.
          </Typography.Text>
        ) : (
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={rows}
            scroll={{ x: "max-content", y: "calc(100vh - 420px)" }}
            columns={[
              { title: "Изделие", render: (_, r) => <div title={r.l.item_name}><ItemChars chars={r.l.item_chars} name={r.l.item_name} strong={false} showName={false} /></div> },
              { title: "Операция", render: (_, r) => r.op.name },
              {
                title: "Сделано",
                render: (_, r) => (
                  <Space size={8}>
                    <Progress percent={pct(r.op.good, r.l.quantity)} size="small" style={{ width: 90, margin: 0 }} />
                    <span>
                      {r.op.good} из {r.l.quantity}
                    </span>
                  </Space>
                ),
              },
              { title: "Брак", align: "right", render: (_, r) => (r.op.defect ? <Typography.Text type="danger">{r.op.defect}</Typography.Text> : "—") },
              { title: "Осталось", align: "right", render: (_, r) => r.op.remaining },
            ]}
          />
        )}
      </Space>
    );
  };

  const items: SectionItem[] = [
    {
      key: "all",
      label: "Все строки",
      sub: `${order.lines.length} строк · готово ${totalDone} из ${totalQty}`,
      children: matrix,
    },
    ...(order.tasks ?? []).map((t) => ({
      key: `t${t.id}`,
      group: "Задания участкам",
      label: t.area_name ?? t.area,
      sub: `№${t.id} · ${period(t.plan_from ?? null, t.plan_to ?? null)} · ${t.done}/${t.planned}`,
      mark: t.for_task_id ? "п/ф" : !t.is_active ? "архив" : t.done >= t.planned && t.planned > 0 ? "готово" : undefined,
      children: taskTable(t),
    })),
  ];
  return <SectionsView items={items} initial="all" />;
}
