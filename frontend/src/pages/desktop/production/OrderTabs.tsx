import { useState } from "react";
import { Button, Card, Checkbox, DatePicker, Empty, InputNumber, Progress, Space, Table, Tag, Typography, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { isAxiosError } from "axios";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../../auth/AuthContext";
import {
  getTaskCard,
  listProductionTasks,
  type ProductionTask,
} from "../../../api/production";
import { listPlanSlots, type PlanSlot } from "../../../api/planning";
import { setOrderPlanDates, type ProductionOrder } from "../../../api/productionOrders";

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Задания этого заказа из общего списка заданий (кэш «Задания цеха»). */
function useOrderTasks(order: ProductionOrder) {
  const q = useQuery({
    queryKey: ["production-tasks"],
    queryFn: listProductionTasks,
  });
  return {
    tasks: (q.data ?? []).filter((t) => t.production_order_id === order.id),
    loading: q.isLoading,
  };
}

type FilmRow = {
  key: string;
  film: string;
  strip: number;
  planned: number;
  issued: number;
  short: number;
  rolls: number[];
};

/** «Материалы» заказа: плёнка (нужно / выдано / не хватает по штрипсам),
 * детали п/ф (задания п/ф заказа с ходом) и комплектующие позиций. */
export function OrderMaterials({
  order,
  onOpenTask,
}: {
  order: ProductionOrder;
  onOpenTask: (id: number) => void;
}) {
  const { tasks, loading } = useOrderTasks(order);
  const film = new Map<string, FilmRow>();
  for (const t of tasks)
    for (const l of t.lines) {
      if (!l.material) continue;
      const strip = l.strip_width_mm || l.width_mm;
      const key = `${l.material}|${l.color}|${l.thickness}|${strip}`;
      const row = film.get(key) ?? {
        key,
        film: `${l.material}, ${l.color}, ${l.thickness} мм`,
        strip,
        planned: 0,
        issued: 0,
        short: 0,
        rolls: [],
      };
      row.planned += l.planned_length_m;
      row.issued += l.issued_length_m;
      row.short += l.shortfall_length_m;
      for (const u of l.issued_units)
        if (u.status === "Выдан_участку" && !row.rolls.includes(u.id))
          row.rolls.push(u.id);
      film.set(key, row);
    }
  const pfTasks = tasks.filter(
    (t) =>
      t.for_task_id != null ||
      t.lines.every((l) => l.material === null && l.part_name),
  );
  const comps = new Map<
    string,
    { name: string; unit: string; total: number; left: number }
  >();
  for (const l of order.lines)
    for (const c of l.components) {
      const k = `${c.item_id}:${c.unit}`;
      const e = comps.get(k) ?? {
        name: c.name,
        unit: c.unit,
        total: 0,
        left: 0,
      };
      e.total += c.total;
      e.left += c.per_unit * Math.max(0, l.quantity - l.done);
      comps.set(k, e);
    }
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <section>
        <Typography.Title level={5}>Плёнка</Typography.Title>
        {film.size === 0 ? (
          <Typography.Text type="secondary">
            {loading ? "Загрузка…" : "Плёнка по заказу не нужна."}
          </Typography.Text>
        ) : (
          <Table<FilmRow>
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={[...film.values()].sort((a, b) => b.short - a.short)}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Плёнка", dataIndex: "film" },
              { title: "Штрипс, мм", dataIndex: "strip" },
              { title: "Нужно, м", render: (_, r) => r1(r.planned) },
              { title: "Выдано, м", render: (_, r) => r1(r.issued) },
              {
                title: "Не хватает",
                render: (_, r) =>
                  r.short > 0 ? (
                    <Tag color="orange">{r1(r.short)} м</Tag>
                  ) : (
                    <Tag color="green">выдано достаточно</Tag>
                  ),
              },
              {
                title: "Рулоны на участке",
                render: (_, r) =>
                  r.rolls.length
                    ? r.rolls.map((id) => <Tag key={id}>№{id}</Tag>)
                    : "—",
              },
            ]}
          />
        )}
      </section>
      <section>
        <Typography.Title level={5}>Детали п/ф</Typography.Title>
        {pfTasks.length === 0 ? (
          <Typography.Text type="secondary">
            Заданий на п/ф в заказе нет.
          </Typography.Text>
        ) : (
          <Table<ProductionTask>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={pfTasks}
            onRow={(t) => ({
              onClick: () => onOpenTask(t.id),
              style: { cursor: "pointer" },
            })}
            columns={[
              {
                title: "Задание",
                render: (_, t) => (
                  <a>
                    №{t.id} «{t.name}»
                  </a>
                ),
              },
              {
                title: "Детали",
                render: (_, t) =>
                  [...new Set(t.lines.map((l) => l.part_name))].join(", "),
              },
              {
                title: "Готово",
                render: (_, t) => {
                  const plan = t.lines.reduce(
                    (s, l) => s + l.quantity_pieces,
                    0,
                  );
                  const done = t.lines.reduce(
                    (s, l) =>
                      s + Math.min(l.produced_good_pieces, l.quantity_pieces),
                    0,
                  );
                  return (
                    <Progress
                      percent={plan ? Math.round((done / plan) * 100) : 0}
                      size="small"
                      style={{ width: 120, margin: 0 }}
                    />
                  );
                },
              },
            ]}
          />
        )}
      </section>
      <section>
        <Typography.Title level={5}>Комплектующие</Typography.Title>
        {comps.size === 0 ? (
          <Typography.Text type="secondary">
            Комплектующих в составе позиций нет.
          </Typography.Text>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {[...comps.values()].map((c) => (
              <li key={c.name + c.unit}>
                {c.name} — осталось {r1(c.left)} {c.unit}
                <Typography.Text type="secondary">
                  {" "}
                  (всего {r1(c.total)} {c.unit})
                </Typography.Text>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Space>
  );
}

/** «План» заказа: дни из планировщика по всем участкам заказа. */
/** Ручные сроки: этап (задание участка) — на дату, весь заказ — сдвиг на N
 * рабочих дней; следующие этапы сдвигаются за изменённым (по галочке).
 * Поставленное вручную пересчёт сроков не трогает. */
function PlanDatesEditor({ order }: { order: ProductionOrder }) {
  const qc = useQueryClient();
  const [dates, setDates] = useState<Record<number, Dayjs | null>>({});
  const [shift, setShift] = useState<number | null>(null);
  const [shiftNext, setShiftNext] = useState(true);
  const tasks = (order.tasks ?? []).filter((t) => t.is_active);
  const done = () => {
    for (const k of [["production-orders"], ["plan-slots"], ["plan-board"], ["order-readiness"], ["invoice-readiness"]]) qc.invalidateQueries({ queryKey: k });
  };
  const mutation = useMutation({
    mutationFn: (payload: { tasks?: { task_id: number; date: string }[]; shift_days?: number }) =>
      setOrderPlanDates(order.id, { ...payload, shift_next: shiftNext }),
    onSuccess: (o) => {
      done();
      setDates({});
      setShift(null);
      message.success(o.plan_finish ? `Сроки обновлены — готово к ${dayjs(o.plan_finish).format("DD.MM")}` : "Сроки обновлены");
    },
    onError: (e) => message.error(isAxiosError(e) && typeof e.response?.data?.detail === "string" ? e.response.data.detail : "Не удалось поменять сроки"),
  });
  const fmt = (s?: string | null) => (s ? dayjs(s).format("DD.MM") : "—");
  return (
    <Card size="small" title="Сроки — вручную">
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space wrap>
          <Typography.Text>Весь заказ: сдвинуть на</Typography.Text>
          <InputNumber value={shift} onChange={setShift} style={{ width: 90 }} placeholder="±дн." />
          <Typography.Text>рабочих дней</Typography.Text>
          <Button disabled={!shift} loading={mutation.isPending} onClick={() => mutation.mutate({ shift_days: shift ?? 0 })}>
            Сдвинуть
          </Button>
          <Checkbox checked={shiftNext} onChange={(e) => setShiftNext(e.target.checked)}>
            при переносе этапа сдвигать следующие за ним
          </Checkbox>
        </Space>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={tasks}
          columns={[
            {
              title: "Этап (участок)",
              render: (_, t) => (
                <Space size={4}>
                  {t.area_name ?? t.area}
                  {t.for_task_id != null && <Tag>п/ф</Tag>}
                </Space>
              ),
            },
            { title: "Сейчас", render: (_, t) => (t.plan_from ? `${fmt(t.plan_from)}${t.plan_to && t.plan_to !== t.plan_from ? `–${fmt(t.plan_to)}` : ""}` : "не в плане") },
            {
              title: "Поставить на дату",
              render: (_, t) => (
                <Space>
                  <DatePicker format="DD.MM.YYYY" value={dates[t.id] ?? null} onChange={(v) => setDates((d) => ({ ...d, [t.id]: v }))} />
                  <Button
                    size="small"
                    disabled={!dates[t.id]}
                    loading={mutation.isPending}
                    onClick={() => mutation.mutate({ tasks: [{ task_id: t.id, date: dates[t.id]!.format("YYYY-MM-DD") }] })}
                  >
                    Поставить
                  </Button>
                </Space>
              ),
            },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Несделанное по этапу встаёт на выбранный день (выходные переносятся на понедельник). Ручные сроки пересчёт
          («Пересчитать сроки») не трогает; по дням точнее — в «Планировщике».
        </Typography.Text>
      </Space>
    </Card>
  );
}

export function OrderPlan({ order }: { order: ProductionOrder }) {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const areas = [...new Set((order.tasks ?? []).map((t) => t.area))];
  const from = dayjs().subtract(14, "day").format("YYYY-MM-DD");
  const to = dayjs().add(60, "day").format("YYYY-MM-DD");
  const qs = useQueries({
    queries: areas.map((area) => ({
      queryKey: ["plan-slots", area, from, to, "order"],
      queryFn: () => listPlanSlots({ area, date_from: from, date_to: to }),
    })),
  });
  const names = new Map(
    (order.tasks ?? []).map((t) => [t.area, t.area_name ?? t.area]),
  );
  const rows: (PlanSlot & { area_name: string })[] = qs
    .flatMap((q) => q.data ?? [])
    .filter((s) => s.order_id === order.id)
    .map((s) => ({ ...s, area_name: names.get(s.area) ?? s.area }))
    .sort(
      (a, b) =>
        (a.date ?? "").localeCompare(b.date ?? "") ||
        a.area_name.localeCompare(b.area_name, "ru"),
    );
  const loading = qs.some((q) => q.isLoading);
  if (!loading && !rows.length)
    return (
      <Space direction="vertical" style={{ width: "100%" }}>
        {canManage && order.status === "released" && <PlanDatesEditor order={order} />}
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="В планировщике по заказу ничего не стоит — «Ещё → Пересчитать сроки» или поставьте этапы на даты выше"
        />
      </Space>
    );
  const ship = order.ship_date;
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {canManage && order.status === "released" && <PlanDatesEditor order={order} />}
      {ship && (
        <Typography.Text type="secondary">
          Отгрузка {dayjs(ship).format("DD.MM.YYYY")} — дни позже неё
          подсвечены.
        </Typography.Text>
      )}
      <Table
        size="small"
        loading={loading}
        rowKey={(s) => `${s.id}-${s.task_line_id}-${s.date}`}
        pagination={false}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        columns={[
          {
            title: "День",
            render: (_, s) => (
              <Space size={4}>
                {s.date ? dayjs(s.date).format("DD.MM") : "—"}
                {s.overdue && <Tag color="red">просрочено</Tag>}
                {ship && s.date && s.date > ship && (
                  <Tag color="orange">после отгрузки</Tag>
                )}
              </Space>
            ),
          },
          { title: "Участок", dataIndex: "area_name" },
          {
            title: "Что",
            render: (_, s) =>
              `${s.what}${s.operation ? ` · ${s.operation}` : ""}`,
          },
          { title: "План, шт", dataIndex: "quantity" },
          {
            title: "Сделано по строке",
            render: (_, s) => `${s.line_done} из ${s.line_plan}`,
          },
        ]}
      />
    </Space>
  );
}

/** «История» заказа: создан/запущен и все отчёты по его заданиям. */
export function OrderHistory({ order }: { order: ProductionOrder }) {
  const tasks = order.tasks ?? [];
  const qs = useQueries({
    queries: tasks.map((t) => ({
      queryKey: ["production-tasks", "card", t.id],
      queryFn: () => getTaskCard(t.id),
    })),
  });
  type Ev = { key: string; at: string; who: string; text: string };
  const events: Ev[] = [
    {
      key: "created",
      at: order.created_at,
      who: order.created_by_name,
      text: "Заказ создан",
    },
    ...(order.released_at
      ? [
          {
            key: "released",
            at: order.released_at,
            who: "",
            text: "Заказ запущен в производство",
          },
        ]
      : []),
  ];
  qs.forEach((q, i) => {
    for (const r of q.data?.reports ?? [])
      events.push({
        key: `r${r.id}`,
        at: r.reported_at,
        who: r.user_name ?? "",
        text:
          `${tasks[i].area_name ?? tasks[i].area}: ${r.part_name ?? "—"}${r.operation_name ? ` · ${r.operation_name}` : ""} — ` +
          [
            r.good_pieces > 0 ? `${r.good_pieces} годных` : "",
            r.defect_pieces > 0
              ? `брак ${r.defect_pieces}${r.defect_reason_name ? ` (${r.defect_reason_name})` : ""}`
              : "",
            r.material_unit_id ? `рулон №${r.material_unit_id}` : "",
            r.note ?? "",
          ]
            .filter(Boolean)
            .join(", "),
      });
  });
  events.sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Table<Ev>
      size="small"
      rowKey="key"
      loading={qs.some((q) => q.isLoading)}
      pagination={{ pageSize: 50, hideOnSinglePage: true }}
      dataSource={events}
      columns={[
        {
          title: "Когда",
          render: (_, e) => dayjs(e.at).format("DD.MM HH:mm"),
          width: 110,
        },
        { title: "Кто", dataIndex: "who", width: 170 },
        { title: "Что", dataIndex: "text" },
      ]}
    />
  );
}
