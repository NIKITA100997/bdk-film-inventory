import { useState } from "react";
import { Button, InputNumber, Popover, Progress, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ItemChars } from "../../../components/ItemChars";
import { markOrderLineReady, type OrderLine, type OrderTask, type ProductionOrder } from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";
import { SectionsView, period, type SectionItem } from "./LayoutSheets";
import { TaskCardPanel } from "./TaskCardDrawer";

const pct = (a: number, b: number) => (b ? Math.round((Math.min(a, b) / b) * 100) : 0);
const color = (a: number, b: number) => (a >= b && b > 0 ? "#389e0d" : a > 0 ? "#C97A2B" : undefined);

/** «Готово» по строке изделия без этапов (царговые, 16.10): сколько штук
 * готово сейчас — приход на склад готовой продукции. */
function ReadyButton({ order, line }: { order: ProductionOrder; line: OrderLine }) {
  const qc = useQueryClient();
  const left = Math.max(0, line.quantity - line.done);
  const [qty, setQty] = useState<number | null>(left);
  const [open, setOpen] = useState(false);
  const m = useMutation({
    mutationFn: () => markOrderLineReady(order.id, line.id, qty ?? 0),
    onSuccess: (o) => {
      qc.setQueryData(["production-order", order.id], o);
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      message.success(`Готово: ${qty} шт — на складе готовой продукции`);
      setOpen(false);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отметить готовность")),
  });
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setQty(left);
      }}
      title="Сколько готово сейчас"
      content={
        <Space direction="vertical">
          <Space>
            <InputNumber min={1} max={left} value={qty} onChange={setQty} addonAfter="шт" style={{ width: 140 }} />
            <Button type="primary" disabled={!qty} loading={m.isPending} onClick={() => m.mutate()}>
              Готово
            </Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Поступит на склад готовой продукции по счёту {line.invoice_no ?? "—"}
          </Typography.Text>
        </Space>
      }
    >
      <Button size="small">Готово…</Button>
    </Popover>
  );
}

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
              {l.without_route ? (
                <Tag title="Изделие без этапов: в работе с запуска, готовность — отметкой «Готово…»">без этапов</Tag>
              ) : (
                l.operations.length === 0 && <Typography.Text type="warning"> нет маршрута</Typography.Text>
              )}
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
          width: 150,
          render: (_, l) => (
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Progress percent={pct(l.done, l.quantity)} size="small" format={() => `${l.done}/${l.quantity}`} />
              {l.without_route && canManage && order.status === "released" && l.done < l.quantity && <ReadyButton order={order} line={l} />}
              {l.without_route && order.status === "released" && l.done === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  в работе
                </Typography.Text>
              )}
            </Space>
          ),
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
          {rows.length > 0 && (
            <Button type="primary" onClick={() => onOpenTask(t.id)}>
              Открыть задание №{t.id}
            </Button>
          )}
          {canManage && t.is_active && t.with_parts && <Button onClick={() => onSupply(t)}>Обеспечение п/ф</Button>}
          <Typography.Text type="secondary">
            {t.name} · план {period(t.plan_from ?? null, t.plan_to ?? null)}
          </Typography.Text>
        </Space>
        {rows.length === 0 ? (
          // строки задания — детали п/ф (окутка из наряда, заготовки): карточка задания прямо здесь
          <TaskCardPanel taskId={t.id} canManage={canManage} canReport={canManage} />
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
    ...(order.lines.length === 0 ? [] : [{
      key: "all",
      label: "Все строки",
      sub: `${order.lines.length} строк · готово ${totalDone} из ${totalQty}`,
      children: matrix,
    }]),
    ...(order.tasks ?? []).map((t) => ({
      key: `t${t.id}`,
      group: "Задания участкам",
      label: t.area_name ?? t.area,
      sub: `№${t.id} · ${period(t.plan_from ?? null, t.plan_to ?? null)} · ${t.done}/${t.planned}`,
      mark: t.for_task_id ? "п/ф" : !t.is_active ? "архив" : t.done >= t.planned && t.planned > 0 ? "готово" : undefined,
      children: taskTable(t),
    })),
  ];
  // заказ без строк (задание на окутку, заготовки) — сразу первое задание
  return <SectionsView items={items} initial={items[0]?.key ?? "all"} />;
}
