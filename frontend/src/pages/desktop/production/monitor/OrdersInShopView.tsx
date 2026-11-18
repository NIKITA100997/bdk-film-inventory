import { useMemo, useState } from "react";
import { Button, Card, Empty, Progress, Space, Table, Tabs, Tag, Tooltip, Typography, theme } from "antd";
import { ApartmentOutlined, CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, ExportOutlined, PrinterOutlined, WarningOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import type { MonitorArea, MonitorOrder, MonitorRow } from "../../../../api/productionMonitor";
import ResponsiveTable from "../../../../components/ResponsiveTable";
import { UiBadge } from "../../../../components/UiBadge";
import QuickReport from "./QuickReport";
import { buildLines, type LineRec } from "./OrdersView";
import type { PrintableTask } from "../PrintTasksModal";

const r2 = (v: number) => Math.round(v * 100) / 100;
const dm = (s: string | null | undefined) => (s ? dayjs(s).format("DD.MM") : "");
const leftOf = (r: MonitorRow) => (r.closed ? 0 : Math.max(0, r.plan - r.good));
const doneOf = (r: MonitorRow) => (r.closed ? r.plan : Math.min(r.good, r.plan));
const posOf = (r: MonitorRow) => (r.part_id == null && (r.series || r.size) ? [r.series, r.size, r.color].filter(Boolean).join(" · ") : r.position);

export interface OrderMilestone {
  key: string;
  label: string;
  badge: string;
  status: "done" | "in_work" | "pending" | "deficit";
  tooltip: string;
}

export interface OrderInShopSummary {
  orderId: number;
  orderName: string;
  kind: string;
  shipDate: string | null;
  launchDate: string | null;
  daysLeft: number | null;
  invoices: string[];
  seriesList: string[];
  positionsCount: number;
  totalPlan: number;
  totalDone: number;
  totalLeft: number;
  progressPercent: number;
  hasDeficit: boolean;
  filmDeficitM: number;
  milestones: OrderMilestone[];
  bottleneck: string;
  bottleneckType: "deficit" | "warning" | "in_work" | "ready";
  rows: MonitorRow[];
}

export interface OrdersInShopViewProps {
  rows: MonitorRow[];
  orders: MonitorOrder[];
  areas: MonitorArea[];
  hideDone: boolean;
  onOpenTask: (taskId: number) => void;
  onOpenOrder?: (orderId: number) => void;
  onPrintTasks?: (spec: { tasks: PrintableTask[]; title: string }) => void;
}

interface TaskStageCategory {
  seq: number;
  label: string;
  tagColor: string;
}

/** Определение технологического этапа задания для строгой сортировки по маршруту цеха */
function getTaskCategory(r: MonitorRow): TaskStageCategory {
  const isPf = r.part_id != null;
  const pos = (r.position || "").toLowerCase();
  const op = (r.operation || "").toLowerCase();
  const area = (r.area || "").toLowerCase();

  // 1. Полуфабрикаты: Каркасы
  if (isPf && (pos.includes("каркас") || op.includes("каркас") || area.includes("karkas"))) {
    const isSawing = op.includes("распил") || op.includes("заготов");
    return { seq: isSawing ? 10 : 15, label: "Каркас", tagColor: "orange" };
  }
  // 2. Полуфабрикаты: Панели / скины / МДФ
  if (isPf) {
    let sub = 25;
    if (op.includes("распил") || op.includes("раскрой")) sub = 21;
    else if (op.includes("фрезер")) sub = 22;
    else if (op.includes("шлиф")) sub = 23;
    else if (op.includes("прес") || op.includes("мвп") || op.includes("окут")) sub = 24;
    return { seq: sub, label: "Панель", tagColor: "volcano" };
  }
  // 3. Сборка полотна: Склейка / опрессовка
  if (op.includes("склей") || op.includes("опресс") || op.includes("щит") || area.includes("skleik") || area.includes("press")) {
    return { seq: 30, label: "Склейка", tagColor: "blue" };
  }
  // 4. Механическая обработка: Форматка и кромка
  if (op.includes("формат") || op.includes("кромк") || area.includes("kromk")) {
    const isFormat = op.includes("формат");
    return { seq: isFormat ? 40 : 45, label: "Кромка", tagColor: "cyan" };
  }
  // 5. Фурнитура: Врезка замков, петель
  if (op.includes("петл") || op.includes("замок") || op.includes("фурнитур") || op.includes("врезк")) {
    return { seq: 50, label: "Фурнитура", tagColor: "purple" };
  }
  // 6. Упаковка полотен и изделий
  if (op.includes("упаков") || area.includes("upakov") || area.includes("pack")) {
    return { seq: 60, label: "Упаковка", tagColor: "green" };
  }
  // 7. Погонажные изделия
  if (pos.includes("короб") || pos.includes("налич") || pos.includes("добор") || r.direction === "trim") {
    return { seq: 70, label: "Погонаж", tagColor: "gold" };
  }
  return { seq: 80, label: "Полотно", tagColor: "default" };
}

/** Детальная внутренняя панель заказа: технологические задания цеха и спецификация позиций */
function ExpandedOrderTasks({
  order,
  lines,
  areaNameMap,
  onOpenTask,
  onOpenOrder,
  onPrintTasks,
}: {
  order: OrderInShopSummary;
  lines: LineRec[];
  areaNameMap: Map<string, string>;
  onOpenTask: (taskId: number) => void;
  onOpenOrder?: (orderId: number) => void;
  onPrintTasks?: (spec: { tasks: PrintableTask[]; title: string }) => void;
}) {
  const { token } = theme.useToken();
  const [activeTab, setActiveTab] = useState("tasks");

  // Строгая сортировка заданий: сначала каркасы, затем панели, склейка, кромка, фурнитура, упаковка
  const sortedRows = useMemo(() => {
    return [...order.rows].sort((a, b) => {
      const ca = getTaskCategory(a);
      const cb = getTaskCategory(b);
      if (ca.seq !== cb.seq) return ca.seq - cb.seq;
      if ((a.op_seq ?? 0) !== (b.op_seq ?? 0)) return (a.op_seq ?? 0) - (b.op_seq ?? 0);
      return a.task_line_id - b.task_line_id;
    });
  }, [order.rows]);

  const handlePrint = () => {
    if (!onPrintTasks) return;
    const tasksMap = new Map<number, PrintableTask>();
    for (const r of order.rows) {
      if (r.task_id && !r.closed) {
        tasksMap.set(r.task_id, {
          id: r.task_id,
          area: r.area,
          area_name: areaNameMap.get(r.area) ?? r.area,
        });
      }
    }
    onPrintTasks({
      tasks: Array.from(tasksMap.values()),
      title: `Наряды заказа №${order.orderId} «${order.orderName}»`,
    });
  };

  return (
    <div style={{ margin: "4px 0 10px 0", padding: "10px 14px", background: "#fafafa", borderRadius: 8, border: "1px solid #f0f0f0" }}>
      {/* Верхняя панель управления заказом прямо из таблицы */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <Space wrap size={8} style={{ alignItems: "center" }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            Заказ №{order.orderId} «{order.orderName}»
          </Typography.Text>
          {order.kind === "stock" && <UiBadge color="green">на склад</UiBadge>}
          {order.shipDate && (
            <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
              Срок отгрузки: <b>{dm(order.shipDate)}</b>
            </span>
          )}
          {onOpenOrder && (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<ExportOutlined />}
              onClick={() => onOpenOrder(order.orderId)}
              title="Открыть карточку заказа со всеми вкладками (Ход, Отчёт, Материалы, План, История)"
            >
              Полная карточка заказа ↗
            </Button>
          )}
        </Space>

        <Space wrap size={6}>
          <Button size="small" icon={<PrinterOutlined />} onClick={handlePrint}>
            Печать нарядов
          </Button>
        </Space>
      </div>

      {/* Вкладки: задания цеха и спецификация позиций */}
      <Tabs
        size="small"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "tasks",
            label: `📋 Задания цеха (${sortedRows.length})`,
            children: (
              <Table<MonitorRow>
                size="small"
                rowKey="task_line_id"
                dataSource={sortedRows}
                pagination={false}
                scroll={{ x: 1040 }}
                columns={[
                  {
                    title: "Этап",
                    width: 95,
                    render: (_, r) => {
                      const cat = getTaskCategory(r);
                      return <Tag color={cat.tagColor} style={{ fontSize: 11, margin: 0 }}>{cat.label}</Tag>;
                    },
                  },
                  {
                    title: "Участок",
                    width: 140,
                    render: (_, r) => (
                      <Tooltip title={areaNameMap.get(r.area) ?? r.area}>
                        <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", maxWidth: 135 }}>
                          {areaNameMap.get(r.area) ?? r.area}
                        </span>
                      </Tooltip>
                    ),
                  },
                  {
                    title: "Операция",
                    width: 120,
                    render: (_, r) => (
                      <Tooltip title={r.operation || r.area}>
                        <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", maxWidth: 115 }}>
                          {r.operation || r.area}
                        </span>
                      </Tooltip>
                    ),
                  },
                  {
                    title: "Позиция / Деталь",
                    width: 190,
                    render: (_, r) => (
                      <div style={{ maxWidth: 185 }}>
                        <Tooltip title={posOf(r)}>
                          <div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {posOf(r)}
                          </div>
                        </Tooltip>
                        {r.film_deficit_m != null && r.film_deficit_m > 0 && (
                          <Tag color="error" style={{ fontSize: 10, padding: "0 4px", lineHeight: "16px", marginTop: 2 }}>
                            дефицит -{r2(r.film_deficit_m)} м
                          </Tag>
                        )}
                      </div>
                    ),
                  },
                  {
                    title: "План",
                    width: 55,
                    align: "right",
                    render: (_, r) => <span style={{ fontSize: 12 }}>{r2(r.plan)}</span>,
                  },
                  {
                    title: "Сделано",
                    width: 65,
                    align: "right",
                    render: (_, r) => (
                      <span style={{ fontSize: 12 }}>
                        {r2(r.good)}
                        {r.defect > 0 && <Typography.Text type="danger" style={{ fontSize: 10 }}> б{r2(r.defect)}</Typography.Text>}
                      </span>
                    ),
                  },
                  {
                    title: "Осталось",
                    width: 65,
                    align: "right",
                    render: (_, r) =>
                      r.closed ? (
                        <span style={{ color: "#8c8c8c", fontSize: 11 }}>закр</span>
                      ) : leftOf(r) > 0 ? (
                        <b style={{ color: token.colorWarning, fontSize: 12 }}>{r2(leftOf(r))}</b>
                      ) : (
                        <span style={{ color: token.colorSuccess, fontSize: 11 }}>готов</span>
                      ),
                  },
                  {
                    title: "Срок",
                    width: 60,
                    render: (_, r) => (r.date_from ? <span style={{ fontSize: 11 }}>{dm(r.date_from)}</span> : "—"),
                  },
                  {
                    title: "Плёнка",
                    width: 80,
                    render: (_, r) => {
                      if (!r.film && !r.film_status) return "—";
                      if (r.film_status === "issued" || r.film_status === "covered" || r.film_status === "site_stock") {
                        return <Tag color="green" style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>выдана</Tag>;
                      }
                      if (r.film_status === "partial") return <Tag color="orange" style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>частично</Tag>;
                      return <Tag color="red" style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>не выдана</Tag>;
                    },
                  },
                  {
                    title: "Отчёт в цехе",
                    width: 220,
                    render: (_, r) =>
                      r.quick && leftOf(r) >= 0 ? (
                        <QuickReport row={r} compact />
                      ) : (
                        <Button size="small" onClick={() => onOpenTask(r.task_id)}>
                          Задание №{r.task_id}
                        </Button>
                      ),
                  },
                ]}
              />
            ),
          },
          ...(lines.length > 0
            ? [
                {
                  key: "lines",
                  label: `🚪 Позиции заказа (${lines.length})`,
                  children: (
                    <Table<LineRec>
                      size="small"
                      rowKey="key"
                      dataSource={lines}
                      pagination={false}
                      scroll={{ x: 860 }}
                      columns={[
                        {
                          title: "Счёт",
                          width: 110,
                          render: (_, l) =>
                            l.invoice ? <UiBadge color="purple">{l.invoice}</UiBadge> : <span style={{ color: "#8c8c8c" }}>—</span>,
                        },
                        {
                          title: "Серия / Модель",
                          width: 140,
                          render: (_, l) => <b>{l.series || "—"}</b>,
                        },
                        {
                          title: "Размер",
                          width: 110,
                          render: (_, l) => l.size || "—",
                        },
                        {
                          title: "Цвет / Декор",
                          width: 150,
                          render: (_, l) => (
                            <Tooltip title={l.color}>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", maxWidth: 145 }}>
                                {l.color || "—"}
                              </span>
                            </Tooltip>
                          ),
                        },
                        {
                          title: "План",
                          width: 65,
                          align: "right",
                          render: (_, l) => r2(l.qty),
                        },
                        {
                          title: "Сдано",
                          width: 70,
                          align: "right",
                          render: (_, l) => r2(Math.max(0, l.qty - l.left)),
                        },
                        {
                          title: "Осталось",
                          width: 75,
                          align: "right",
                          render: (_, l) =>
                            l.left <= 0 ? (
                              <Tag color="success" style={{ margin: 0 }}>готово</Tag>
                            ) : (
                              <b>{r2(l.left)}</b>
                            ),
                        },
                        {
                          title: "Комплекты П/Ф",
                          width: 110,
                          render: (_, l) =>
                            l.pf ? (
                              <span style={{ fontSize: 12 }}>
                                {r2(l.pf.readySets)} из {r2(l.pf.totalSets || l.qty)}
                              </span>
                            ) : "—",
                        },
                      ]}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

export default function OrdersInShopView({
  rows,
  orders,
  areas,
  hideDone,
  onOpenTask,
  onOpenOrder,
  onPrintTasks,
}: OrdersInShopViewProps) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const areaNameMap = useMemo(() => new Map(areas.map((a) => [a.code, a.name])), [areas]);
  const orderMap = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);

  // Сбор позиций заказа и операций
  const { lines } = useMemo(() => buildLines(rows, orders, areas), [rows, orders, areas]);

  // Линии заказов по order_id (для сводок и вложенных позиций)
  const linesByOrder = useMemo(() => {
    const m = new Map<number, LineRec[]>();
    for (const l of lines.values()) {
      const list = m.get(l.order_id) ?? [];
      list.push(l);
      m.set(l.order_id, list);
    }
    return m;
  }, [lines]);

  const ordersList: OrderInShopSummary[] = useMemo(() => {
    // Группируем строки монитора по order_id
    const rowsByOrder = new Map<number, MonitorRow[]>();
    for (const r of rows) {
      if (r.order_id != null) {
        const list = rowsByOrder.get(r.order_id) ?? [];
        list.push(r);
        rowsByOrder.set(r.order_id, list);
      }
    }

    const today = dayjs().startOf("day");
    const result: OrderInShopSummary[] = [];

    for (const [orderId, orderRows] of rowsByOrder.entries()) {
      const o = orderMap.get(orderId);
      const oLines = linesByOrder.get(orderId) ?? [];

      // Расчет планового количества и готовности
      let totalPlan = 0;
      let totalDone = 0;
      let totalLeft = 0;

      if (oLines.length > 0) {
        totalPlan = oLines.reduce((s, l) => s + l.qty, 0);
        totalLeft = oLines.reduce((s, l) => s + l.left, 0);
        totalDone = Math.max(0, totalPlan - totalLeft);
      } else {
        totalPlan = orderRows.reduce((s, r) => s + r.plan, 0);
        totalDone = orderRows.reduce((s, r) => s + doneOf(r), 0);
        totalLeft = orderRows.reduce((s, r) => s + leftOf(r), 0);
      }

      if (hideDone && totalLeft <= 0) {
        continue;
      }

      // Сроки
      const shipDate = o?.ship_date ?? null;
      let daysLeft: number | null = null;
      if (shipDate) {
        daysLeft = dayjs(shipDate).startOf("day").diff(today, "day");
      }

      // Счета и серии
      const invoicesSet = new Set<string>();
      const seriesSet = new Set<string>();
      for (const r of orderRows) {
        if (r.invoice_no) invoicesSet.add(r.invoice_no);
        if (r.series) seriesSet.add(r.series);
        for (const s of r.source_orders ?? []) {
          if (s.invoice_no) invoicesSet.add(s.invoice_no);
          if (s.series) seriesSet.add(s.series);
        }
      }
      for (const l of oLines) {
        if (l.invoice) invoicesSet.add(l.invoice);
        if (l.series) seriesSet.add(l.series);
      }

      // Дефицит плёнки
      const filmDeficitM = orderRows.reduce((s, r) => s + (r.film_deficit_m ?? 0), 0);
      const hasDeficit = filmDeficitM > 0 || orderRows.some((r) => r.film_status === "none" || r.film_status === "partial");

      // Расчёт компактных вех заказа (Key Milestones) вместо шумной длинной цепочки
      const milestones: OrderMilestone[] = [];

      // 1. Каркасы (П/Ф)
      const frameRows = orderRows.filter(
        (r) => r.part_id != null && (/каркас/i.test(r.position) || r.area === "uchastok_sborki_karkasov" || (r.operation || "").toLowerCase().includes("каркас")),
      );
      if (frameRows.length > 0) {
        const plan = frameRows.reduce((s, r) => s + r.plan, 0);
        const done = frameRows.reduce((s, r) => s + doneOf(r), 0);
        const left = Math.max(0, plan - done);
        const isDone = left <= 0;
        milestones.push({
          key: "frames",
          label: "Каркасы",
          badge: isDone ? `🪵 Каркасы: ${r2(done)} ✔` : `🪵 Каркасы: ${r2(done)}/${r2(plan)}`,
          status: isDone ? "done" : done > 0 ? "in_work" : "pending",
          tooltip: `Каркасы: план ${r2(plan)}, сдано ${r2(done)}, осталось ${r2(left)} шт`,
        });
      }

      // 2. Панели / скины / МДФ (П/Ф)
      const panelRows = orderRows.filter(
        (r) => r.part_id != null && !/каркас/i.test(r.position) && r.area !== "uchastok_sborki_karkasov" && !(r.operation || "").toLowerCase().includes("каркас"),
      );
      if (panelRows.length > 0) {
        const plan = panelRows.reduce((s, r) => s + r.plan, 0);
        const done = panelRows.reduce((s, r) => s + doneOf(r), 0);
        const left = Math.max(0, plan - done);
        const isDone = left <= 0;
        milestones.push({
          key: "panels",
          label: "Панели",
          badge: isDone ? `🪵 Панели: ${r2(done)} ✔` : `🪵 Панели: ${r2(done)}/${r2(plan)}`,
          status: isDone ? "done" : done > 0 ? "in_work" : "pending",
          tooltip: `Панели (скины/МДФ): план ${r2(plan)}, сдано ${r2(done)}, осталось ${r2(left)} шт`,
        });
      }

      // 3. Плёнка
      const filmRows = orderRows.filter((r) => r.film || r.film_status != null || (r.film_need_m ?? 0) > 0);
      if (filmRows.length > 0) {
        if (filmDeficitM > 0) {
          milestones.push({
            key: "film",
            label: "Плёнка",
            badge: `🔴 Дефицит -${r2(filmDeficitM)}м`,
            status: "deficit",
            tooltip: `Дефицит плёнки: ${r2(filmDeficitM)} м`,
          });
        } else {
          const allOk = filmRows.every((r) => r.film_status === "issued" || r.film_status === "covered" || r.film_status === "site_stock");
          milestones.push({
            key: "film",
            label: "Плёнка",
            badge: allOk ? "🎞️ Плёнка ✔" : "🎞️ Плёнка: выдача",
            status: allOk ? "done" : "in_work",
            tooltip: allOk ? "Плёнка выдана на участок или имеется на остатке" : "Плёнка ещё выдаётся со склада",
          });
        }
      }

      // 4. Полотно / Сборка / Готовая продукция
      const doorRows = orderRows.filter((r) => r.part_id == null);
      if (doorRows.length > 0) {
        const packRows = doorRows.filter((r) => (r.operation || "").toLowerCase().includes("упаков") || r.area.toLowerCase().includes("upakov") || r.area.toLowerCase().includes("pack"));
        const edgeRows = doorRows.filter((r) => (r.operation || "").toLowerCase().includes("кромк") || (r.operation || "").toLowerCase().includes("формат") || (r.operation || "").toLowerCase().includes("петл") || (r.operation || "").toLowerCase().includes("замок"));
        const glueRows = doorRows.filter((r) => (r.operation || "").toLowerCase().includes("склей") || (r.operation || "").toLowerCase().includes("опресс") || r.area.toLowerCase().includes("skleik") || r.area.toLowerCase().includes("press"));

        const packPlan = packRows.reduce((s, r) => s + r.plan, 0);
        const packDone = packRows.reduce((s, r) => s + doneOf(r), 0);

        const edgePlan = edgeRows.reduce((s, r) => s + r.plan, 0);
        const edgeDone = edgeRows.reduce((s, r) => s + doneOf(r), 0);

        const gluePlan = glueRows.reduce((s, r) => s + r.plan, 0);
        const glueDone = glueRows.reduce((s, r) => s + doneOf(r), 0);

        if (packRows.length > 0 && packPlan > 0 && packDone >= packPlan) {
          milestones.push({
            key: "assembly",
            label: "Сборка",
            badge: `📦 Упаковано: ${r2(packDone)} ✔`,
            status: "done",
            tooltip: `Упаковано 100% (${r2(packDone)}/${r2(packPlan)} шт)`,
          });
        } else if (packRows.length > 0 && packDone > 0) {
          milestones.push({
            key: "assembly",
            label: "Сборка",
            badge: `📦 Упаковка: ${r2(packDone)}/${r2(packPlan)}`,
            status: "in_work",
            tooltip: `Упаковка в процессе: сдано ${r2(packDone)} из ${r2(packPlan)} шт`,
          });
        } else if (edgeRows.length > 0 && edgeDone > 0) {
          milestones.push({
            key: "assembly",
            label: "Сборка",
            badge: `⚙️ Мехобработка: ${r2(edgeDone)}/${r2(edgePlan)}`,
            status: "in_work",
            tooltip: `Кромка/врезка: ${r2(edgeDone)} из ${r2(edgePlan)} шт`,
          });
        } else if (glueRows.length > 0) {
          const isGlueDone = gluePlan > 0 && glueDone >= gluePlan;
          milestones.push({
            key: "assembly",
            label: "Сборка",
            badge: isGlueDone ? `🚪 Склейка: ${r2(glueDone)} ✔` : `🚪 Склейка: ${r2(glueDone)}/${r2(gluePlan)}`,
            status: isGlueDone ? "done" : glueDone > 0 ? "in_work" : "pending",
            tooltip: `Склейка полотен: сдано ${r2(glueDone)} из ${r2(gluePlan)} шт`,
          });
        } else {
          const dPlan = doorRows.reduce((s, r) => s + r.plan, 0);
          const dDone = doorRows.reduce((s, r) => s + doneOf(r), 0);
          const isDone = dPlan > 0 && dDone >= dPlan;
          milestones.push({
            key: "assembly",
            label: "Сборка",
            badge: isDone ? `🚪 Готово: ${r2(dDone)} ✔` : `🚪 Сборка: ${r2(dDone)}/${r2(dPlan)}`,
            status: isDone ? "done" : dDone > 0 ? "in_work" : "pending",
            tooltip: `Готовая продукция: сдано ${r2(dDone)} из ${r2(dPlan)} шт`,
          });
        }
      }

      // Определение узкого места (bottleneck)
      let bottleneck = "В графике";
      let bottleneckType: OrderInShopSummary["bottleneckType"] = "ready";

      if (filmDeficitM > 0) {
        bottleneck = `Дефицит плёнки -${r2(filmDeficitM)} м`;
        bottleneckType = "deficit";
      } else {
        const incompleteMilestone = milestones.find((m) => m.status !== "done" && m.key !== "film");
        if (incompleteMilestone) {
          bottleneck = incompleteMilestone.label;
          bottleneckType = incompleteMilestone.status === "in_work" ? "in_work" : "warning";
        } else if (totalLeft <= 0 && totalPlan > 0) {
          bottleneck = "Готов к отгрузке";
          bottleneckType = "ready";
        }
      }

      const progressPercent = totalPlan > 0 ? Math.min(100, Math.round((totalDone / totalPlan) * 100)) : 0;

      result.push({
        orderId,
        orderName: o?.name ?? `№${orderId}`,
        kind: o?.kind ?? "regular",
        shipDate,
        launchDate: orderRows.find((r) => r.launch_date)?.launch_date ?? null,
        daysLeft,
        invoices: Array.from(invoicesSet),
        seriesList: Array.from(seriesSet),
        positionsCount: oLines.length || orderRows.length,
        totalPlan,
        totalDone,
        totalLeft,
        progressPercent,
        hasDeficit,
        filmDeficitM,
        milestones,
        bottleneck,
        bottleneckType,
        rows: orderRows,
      });
    }

    // Сортировка: сначала те, у которых отгрузка ближе (просроченные -> срочные -> остальные)
    return result.sort((a, b) => {
      if (a.daysLeft != null && b.daysLeft != null) return a.daysLeft - b.daysLeft;
      if (a.daysLeft != null) return -1;
      if (b.daysLeft != null) return 1;
      return b.orderId - a.orderId;
    });
  }, [rows, lines, orders, hideDone, orderMap]);

  // Сводные метрики
  const metrics = useMemo(() => {
    const totalOrders = ordersList.length;
    const urgentOrders = ordersList.filter((o) => o.daysLeft != null && o.daysLeft <= 2 && o.totalLeft > 0).length;
    const deficitOrders = ordersList.filter((o) => o.hasDeficit).length;
    const readyOrders = ordersList.filter((o) => o.totalLeft <= 0 && o.totalPlan > 0).length;
    const totalPiecesPlan = ordersList.reduce((s, o) => s + o.totalPlan, 0);
    const totalPiecesDone = ordersList.reduce((s, o) => s + o.totalDone, 0);
    return { totalOrders, urgentOrders, deficitOrders, readyOrders, totalPiecesPlan, totalPiecesDone };
  }, [ordersList]);

  // Открытие модалки печати нарядов по конкретному заказу
  const handlePrintOrder = (order: OrderInShopSummary) => {
    if (!onPrintTasks) return;
    const tasksMap = new Map<number, PrintableTask>();
    for (const r of order.rows) {
      if (r.task_id && !r.closed) {
        tasksMap.set(r.task_id, {
          id: r.task_id,
          area: r.area,
          area_name: areaNameMap.get(r.area) ?? r.area,
        });
      }
    }
    onPrintTasks({
      tasks: Array.from(tasksMap.values()),
      title: `Наряды заказа №${order.orderId} «${order.orderName}»`,
    });
  };

  if (!ordersList.length) {
    return <Empty description="Активных заказов в цехе нет или всё отфильтровано" style={{ padding: "40px 0" }} />;
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {/* Метрики цеха */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Заказов в работе
          </Typography.Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: token.colorPrimary }}>
            {metrics.totalOrders}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
            Готово: {metrics.totalPiecesDone} из {metrics.totalPiecesPlan} шт
          </div>
        </Card>

        <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Срочные (≤ 2 дней)
          </Typography.Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: metrics.urgentOrders > 0 ? token.colorError : token.colorText }}>
            {metrics.urgentOrders}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
            {metrics.urgentOrders > 0 ? "Требуют первоочередного внимания" : "Все в графике"}
          </div>
        </Card>

        <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Дефицит плёнки
          </Typography.Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: metrics.deficitOrders > 0 ? token.colorError : token.colorSuccess }}>
            {metrics.deficitOrders}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
            {metrics.deficitOrders > 0 ? "Нужно дорезать или выдать со склада" : "Плёнка обеспечена"}
          </div>
        </Card>

        <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Готовы к отгрузке
          </Typography.Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: token.colorSuccess }}>
            {metrics.readyOrders}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
            Прошли все технологические этапы
          </div>
        </Card>
      </div>

      {/* Таблица заказов в цехе */}
      <ResponsiveTable<OrderInShopSummary>
        tableKey="monitor-orders-shop"
        size="small"
        rowKey="orderId"
        dataSource={ordersList}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 930 }}
        expandable={{
          expandedRowRender: (record) => (
            <ExpandedOrderTasks
              order={record}
              lines={linesByOrder.get(record.orderId) ?? []}
              areaNameMap={areaNameMap}
              onOpenTask={onOpenTask}
              onOpenOrder={onOpenOrder}
              onPrintTasks={onPrintTasks}
            />
          ),
        }}
        columns={[
          {
            title: "Заказ и счета",
            width: 200,
            render: (_, o) => (
              <div style={{ maxWidth: 195 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <a
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onOpenOrder) onOpenOrder(o.orderId);
                      else navigate(`/production-orders/${o.orderId}`);
                    }}
                    style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                    title={`Заказ №${o.orderId} «${o.orderName}» — открыть карточку`}
                  >
                    №{o.orderId} «{o.orderName}»
                  </a>
                  {o.kind === "stock" && <UiBadge color="green">склад</UiBadge>}
                </div>
                {o.invoices.length > 0 && (
                  <div style={{ fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`Счета: ${o.invoices.join(", ")}`}>
                    Счета:{" "}
                    {o.invoices.map((inv) => (
                      <UiBadge key={inv} color="purple" style={{ marginInlineEnd: 4 }}>
                        {inv}
                      </UiBadge>
                    ))}
                  </div>
                )}
                {o.seriesList.length > 0 && (
                  <div style={{ fontSize: 11, color: token.colorTextSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`Серии: ${o.seriesList.join(", ")}`}>
                    Серии: {o.seriesList.join(", ")}
                  </div>
                )}
              </div>
            ),
          },
          {
            title: "Срок отгрузки",
            width: 100,
            render: (_, o) => {
              if (!o.shipDate) {
                return <Typography.Text type="secondary" style={{ fontSize: 12 }}>без срока</Typography.Text>;
              }
              const d = o.daysLeft ?? 0;
              return (
                <div>
                  <b style={{ fontSize: 12 }}>{dm(o.shipDate)}</b>
                  <div style={{ marginTop: 2 }}>
                    {d < 0 ? (
                      <Tag color="error" icon={<WarningOutlined />} style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>
                        -{Math.abs(d)} дн.
                      </Tag>
                    ) : d === 0 ? (
                      <Tag color="error" icon={<ClockCircleOutlined />} style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>
                        сегодня!
                      </Tag>
                    ) : d === 1 ? (
                      <Tag color="warning" icon={<ClockCircleOutlined />} style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>
                        завтра!
                      </Tag>
                    ) : d <= 2 ? (
                      <Tag color="warning" style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>горит {d} дн.</Tag>
                    ) : (
                      <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
                        ост. {d} дн.
                      </span>
                    )}
                  </div>
                </div>
              );
            },
          },
          {
            title: "Узкое место",
            width: 170,
            render: (_, o) => {
              if (o.bottleneckType === "deficit") {
                return (
                  <Tag color="error" icon={<ExclamationCircleOutlined />} style={{ whiteSpace: "normal", fontSize: 11, margin: 0 }}>
                    {o.bottleneck}
                  </Tag>
                );
              }
              if (o.bottleneckType === "warning") {
                return (
                  <Tag color="warning" icon={<ClockCircleOutlined />} style={{ whiteSpace: "normal", fontSize: 11, margin: 0 }}>
                    {o.bottleneck}
                  </Tag>
                );
              }
              if (o.bottleneckType === "in_work") {
                return (
                  <Tag color="processing" icon={<ApartmentOutlined />} style={{ whiteSpace: "normal", fontSize: 11, margin: 0 }}>
                    {o.bottleneck}
                  </Tag>
                );
              }
              return (
                <Tag color="success" icon={<CheckCircleOutlined />} style={{ fontSize: 11, margin: 0 }}>
                  {o.bottleneck}
                </Tag>
              );
            },
          },
          {
            title: "Вехи заказа",
            width: 260,
            render: (_, o) => (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, maxWidth: 260 }}>
                {o.milestones.map((m) => {
                  const isDone = m.status === "done";
                  const isDeficit = m.status === "deficit";
                  const isInWork = m.status === "in_work";

                  let color = "#595959";
                  let bg = "#fafafa";
                  let border = "#d9d9d9";

                  if (isDeficit) {
                    color = "#cf1322";
                    bg = "#fff1f0";
                    border = "#ffa39e";
                  } else if (isDone) {
                    color = "#389e0d";
                    bg = "#f6ffed";
                    border = "#b7eb8f";
                  } else if (isInWork) {
                    color = "#0958d9";
                    bg = "#e6f4ff";
                    border = "#91caff";
                  }

                  return (
                    <Tooltip key={m.key} title={m.tooltip}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "1px 6px",
                          borderRadius: 4,
                          fontSize: 11,
                          lineHeight: "16px",
                          background: bg,
                          border: `1px solid ${border}`,
                          color: color,
                          fontWeight: isInWork ? 600 : 400,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.badge}
                      </span>
                    </Tooltip>
                  );
                })}
              </div>
            ),
          },
          {
            title: "Готовность",
            width: 120,
            render: (_, o) => (
              <Space direction="vertical" size={1} style={{ width: "100%" }}>
                <Progress
                  percent={o.progressPercent}
                  size="small"
                  status={o.hasDeficit ? "exception" : o.progressPercent >= 100 ? "success" : "active"}
                />
                <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
                  <b>{r2(o.totalDone)}</b>/{r2(o.totalPlan)} ({o.progressPercent}%)
                </span>
              </Space>
            ),
          },
          {
            title: "",
            width: 85,
            align: "right",
            render: (_, o) => (
              <Space size={2}>
                <Tooltip title="Печать нарядов заказа">
                  <Button
                    size="small"
                    icon={<PrinterOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePrintOrder(o);
                    }}
                  />
                </Tooltip>
                <Tooltip title="Открыть полную карточку заказа">
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    style={{ padding: "0 6px", fontSize: 11 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onOpenOrder) onOpenOrder(o.orderId);
                      else navigate(`/production-orders/${o.orderId}`);
                    }}
                  >
                    Заказ ↗
                  </Button>
                </Tooltip>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
