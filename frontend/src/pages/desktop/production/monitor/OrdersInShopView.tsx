import { useMemo, useState } from "react";
import { Button, Card, Drawer, Empty, Progress, Space, Tabs, Tag, Tooltip, Typography, theme } from "antd";
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
  customerOrders: NonNullable<MonitorOrder["customer_orders"]>;
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
  filterBar?: React.ReactNode;
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
    else if (op.includes("шлиф")) sub = 22;
    else if (area === "frezerovka_laminirovannykh_paneley" || (op.includes("фрезер") && op.includes("ламин"))) sub = 25; // фрезеровка ламинированных панелей ПОСЛЕ фабрики
    else if (op.includes("фрезер")) sub = 23; // фрезеровка до пленки (МВ-прессы)
    else if (op.includes("прес") || op.includes("мвп") || op.includes("окут") || area === "fabrika" || op.includes("ламинац")) sub = 24; // ламинация / фабрика
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

export function formatSourceModels(sources?: MonitorRow["source_orders"]) {
  if (!sources || sources.length === 0) return null;
  const modelQty = new Map<string, number>();
  for (const s of sources) {
    let name = s.series;
    if (!name && s.item_name) {
      const match = s.item_name.match(/Дверь\s+щитовая\s+([А-Яа-яA-Za-z0-9\-]+)/i);
      name = match ? match[1] : s.item_name;
    }
    name = name || "Модель";
    modelQty.set(name, (modelQty.get(name) ?? 0) + s.quantity_pieces);
  }
  return Array.from(modelQty.entries()).map(([m, qty]) => `${m} (${r2(qty)})`).join(", ");
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
      title: `Наряды задания производства №${order.orderId} «${order.orderName}»`,
    });
  };

  return (
    <div style={{ margin: "4px 0 10px 0", padding: "10px 14px", background: "#fafafa", borderRadius: 8, border: "1px solid #f0f0f0" }}>
      {/* Верхняя панель управления заказом прямо из таблицы */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <Space wrap size={8} style={{ alignItems: "center" }}>
          {order.customerOrders.map((customerOrder) => (
            <UiBadge key={customerOrder.id} color="purple">
              Клиент {customerOrder.customer || "—"} · счёт {customerOrder.invoice_no || `№${customerOrder.id}`}
            </UiBadge>
          ))}
          <Typography.Text strong style={{ fontSize: 13 }}>
            Задание производства №{order.orderId} «{order.orderName}»
          </Typography.Text>
          {order.kind === "stock" && <UiBadge color="green">на склад</UiBadge>}
          {order.shipDate && (
            <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
              Срок отгрузки: <b>{dm(order.shipDate)}</b>
            </span>
          )}
          {onOpenOrder && (
            <Button
              size="middle"
              type="primary"
              ghost
              style={{ minHeight: 44 }}
              icon={<ExportOutlined />}
              onClick={() => onOpenOrder(order.orderId)}
              title="Открыть карточку задания производства со всеми вкладками (Ход, Отчёт, Материалы, План, История)"
            >
              Карточка производства ↗
            </Button>
          )}
        </Space>

        <Space wrap size={6}>
          <Button size="middle" style={{ minHeight: 44 }} icon={<PrinterOutlined />} onClick={handlePrint}>
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
              <ResponsiveTable<MonitorRow>
                cardBreakpoint="xl"
                cardTitleColumn="Позиция / Деталь"
                size="small"
                rowKey="task_line_id"
                dataSource={sortedRows}
                pagination={false}
                scroll={{ x: 1210 }}
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
                    width: 220,
                    render: (_, r) => {
                      const modelsText = formatSourceModels(r.source_orders);
                      return (
                        <div style={{ maxWidth: 215 }}>
                          <Tooltip title={posOf(r)}>
                            <div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {posOf(r)}
                            </div>
                          </Tooltip>
                          {modelsText && r.part_id != null && (
                            <Tooltip
                              title={
                                <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Состав по моделям и счетам:</div>
                                  {r.source_orders?.map((s) => (
                                    <div key={s.order_line_id}>
                                      • {s.invoice_no ? `Счёт ${s.invoice_no}: ` : ""}{s.series || s.item_name || "Модель"} — <b>{r2(s.quantity_pieces)} шт</b>
                                    </div>
                                  ))}
                                </div>
                              }
                            >
                              <div style={{ fontSize: 11, color: token.colorPrimary, marginTop: 2, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                <b>Модели:</b> {modelsText}
                              </div>
                            </Tooltip>
                          )}
                          {r.film_deficit_m != null && r.film_deficit_m > 0 && (
                            <Tag color="error" style={{ fontSize: 10, padding: "0 4px", lineHeight: "16px", marginTop: 2 }}>
                              дефицит -{r2(r.film_deficit_m)} м
                            </Tag>
                          )}
                        </div>
                      );
                    },
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
                    width: 170,
                    render: (_, r) => {
                      const label = r.film || [r.mat_name, r.color_name, r.thickness_mm != null ? `${r.thickness_mm} мм` : null].filter(Boolean).join(" · ");
                      if (!label && !r.film_status) return "—";
                      let status: React.ReactNode = null;
                      if (r.film_status === "issued" || r.film_status === "covered" || r.film_status === "site_stock") {
                        status = <Tag color="green" style={{ margin: 0 }}>обеспечена</Tag>;
                      } else if (r.film_status === "partial") {
                        status = <Tag color="orange" style={{ margin: 0 }}>частично</Tag>;
                      } else if (r.film_status === "none") {
                        status = <Tag color="red" style={{ margin: 0 }}>не выдана</Tag>;
                      }
                      return (
                        <Space direction="vertical" size={4}>
                          {label && <Typography.Text>{label}</Typography.Text>}
                          {status}
                        </Space>
                      );
                    },
                  },
                  {
                    title: "Отчёт в цехе",
                    width: 220,
                    render: (_, r) =>
                      r.quick && leftOf(r) >= 0 ? (
                        <QuickReport row={r} compact />
                      ) : (
                        <Button size="middle" style={{ minHeight: 44 }} onClick={() => onOpenTask(r.task_id)}>
                          Открыть задание №{r.task_id}
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
                  label: `🚪 Позиции задания производства (${lines.length})`,
                  children: (
                    <ResponsiveTable<LineRec>
                      cardBreakpoint="xl"
                      cardTitleColumn="Серия / Модель"
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
  filterBar,
}: OrdersInShopViewProps) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const areaNameMap = useMemo(() => new Map(areas.map((a) => [a.code, a.name])), [areas]);
  const orderMap = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const [detailsOrder, setDetailsOrder] = useState<OrderInShopSummary | null>(null);

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

  const { allOrders, displayedOrders } = useMemo(() => {
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
        // Разделяем переделы: ламинация vs фрезеровка ламинированных панелей
        const millRows = panelRows.filter((r) => r.area === "frezerovka_laminirovannykh_paneley" || (r.operation || "").toLowerCase().includes("фрезер"));
        const lamRows = panelRows.filter((r) => r.area === "fabrika" || r.area === "uchastok_membranno_vakuumnykh_pressov" || /ламинац|окутк/i.test(r.operation || ""));

        // Финальным этапом является фрезеровка (если в заказе есть задания фрезеровки ламин. панелей), иначе ламинация
        const finalRows = millRows.length > 0 ? millRows : lamRows.length > 0 ? lamRows : panelRows;
        const plan = finalRows.reduce((s, r) => s + r.plan, 0);
        const done = finalRows.reduce((s, r) => s + doneOf(r), 0);
        const left = Math.max(0, plan - done);
        const isDone = left <= 0;

        let badgeText = `🪵 Панели: ${r2(done)}/${r2(plan)}`;
        if (isDone) {
          badgeText = `🪵 Панели: ${r2(done)} ✔`;
        } else if (millRows.length > 0 && lamRows.length > 0) {
          const lamDone = lamRows.reduce((s, r) => s + doneOf(r), 0);
          const lamPlan = lamRows.reduce((s, r) => s + r.plan, 0);
          const millDone = millRows.reduce((s, r) => s + doneOf(r), 0);
          const millPlan = millRows.reduce((s, r) => s + r.plan, 0);
          badgeText = `🪵 Панели: Лам ${r2(lamDone)}/${r2(lamPlan)}${lamDone >= lamPlan ? " ✔" : ""} · Фрез ${r2(millDone)}/${r2(millPlan)}`;
        }

        milestones.push({
          key: "panels",
          label: "Панели",
          badge: badgeText,
          status: isDone ? "done" : done > 0 ? "in_work" : "pending",
          tooltip: millRows.length > 0
            ? `Панели: ламинация сдана ${r2(lamRows.reduce((s, r) => s + doneOf(r), 0))} шт, фрезеровка ${r2(done)} из ${r2(plan)} шт (осталось ${r2(left)} шт)`
            : `Панели (скины/МДФ): план ${r2(plan)}, сдано ${r2(done)}, осталось ${r2(left)} шт`,
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
        customerOrders: o?.customer_orders ?? [],
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
    const sorted = result.sort((a, b) => {
      if (a.daysLeft != null && b.daysLeft != null) return a.daysLeft - b.daysLeft;
      if (a.daysLeft != null) return -1;
      if (b.daysLeft != null) return 1;
      return b.orderId - a.orderId;
    });

    const displayed = hideDone ? sorted.filter((o) => o.totalLeft > 0) : sorted;
    return { allOrders: sorted, displayedOrders: displayed };
  }, [rows, lines, orders, hideDone, orderMap]);

  // Сводные метрики цеха строго по актуальным данным на экране
  const metrics = useMemo(() => {
    // В работе — строго те, где остался физический остаток производства
    const inWorkOrders = allOrders.filter((o) => o.totalLeft > 0);
    // Готовы — заказы, где всё сдано и остаток равен 0
    const readyOrders = allOrders.filter((o) => o.totalLeft <= 0 && o.totalPlan > 0);

    const urgentOrders = inWorkOrders.filter((o) => o.daysLeft != null && o.daysLeft <= 2);
    const deficitOrders = inWorkOrders.filter((o) => o.hasDeficit);

    const inWorkPlan = inWorkOrders.reduce((s, o) => s + o.totalPlan, 0);
    const inWorkDone = inWorkOrders.reduce((s, o) => s + o.totalDone, 0);
    const inWorkLeft = inWorkOrders.reduce((s, o) => s + o.totalLeft, 0);

    return {
      inWorkCount: inWorkOrders.length,
      urgentCount: urgentOrders.length,
      deficitCount: deficitOrders.length,
      readyCount: readyOrders.length,
      inWorkPlan,
      inWorkDone,
      inWorkLeft,
      displayedCount: displayedOrders.length,
    };
  }, [allOrders, displayedOrders]);

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
      title: `Наряды задания производства №${order.orderId} «${order.orderName}»`,
    });
  };

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {/* 1. Метрики цеха */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Заказов в работе
          </Typography.Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: token.colorPrimary }}>
            {metrics.inWorkCount}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
            Осталось {r2(metrics.inWorkLeft)} из {r2(metrics.inWorkPlan)} шт
          </div>
        </Card>

        <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Срочные (≤ 2 дней)
          </Typography.Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: metrics.urgentCount > 0 ? token.colorError : token.colorText }}>
            {metrics.urgentCount}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
            {metrics.urgentCount > 0 ? "Требуют первоочередного внимания" : "Все в графике"}
          </div>
        </Card>

        <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Дефицит плёнки
          </Typography.Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: metrics.deficitCount > 0 ? token.colorError : token.colorSuccess }}>
            {metrics.deficitCount}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
            {metrics.deficitCount > 0 ? "Нужно дорезать или выдать со склада" : "Плёнка обеспечена"}
          </div>
        </Card>

        <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Готовы к отгрузке
          </Typography.Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: token.colorSuccess }}>
            {metrics.readyCount}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
            {hideDone
              ? (metrics.readyCount > 0 ? `${metrics.readyCount} скр. (вкл. «показывать готовые»)` : "Все заказы в работе")
              : "Отображаются в таблице ниже"}
          </div>
        </Card>
      </div>

      {/* 2. Фильтры и поиск — непосредственно над таблицей */}
      {filterBar}

      {/* 3. Таблица заказов в цехе */}
      {!displayedOrders.length ? (
        <Empty description="Активных заказов в цехе нет или всё отфильтровано" style={{ padding: "30px 0" }} />
      ) : (
        <ResponsiveTable<OrderInShopSummary>
          tableKey="monitor-orders-shop"
          cardBreakpoint="xl"
          cardTitleColumn="Задание производства / заказ клиента"
          size="small"
          rowKey="orderId"
          dataSource={displayedOrders}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1120 }}
          columns={[
          {
            title: "Задание производства / заказ клиента",
            width: 260,
            render: (_, o) => (
              <div style={{ maxWidth: 255 }}>
                {o.customerOrders.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                    {o.customerOrders.map((customerOrder) => (
                      <UiBadge key={customerOrder.id} color="purple" title={customerOrder.customer ?? undefined}>
                        {customerOrder.invoice_no || `Клиент №${customerOrder.id}`}
                      </UiBadge>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <a
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onOpenOrder) onOpenOrder(o.orderId);
                      else navigate(`/production-orders/${o.orderId}`);
                    }}
                    style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                    title={`Задание производства №${o.orderId} «${o.orderName}» — открыть карточку`}
                  >
                    ЗП №{o.orderId} «{o.orderName}»
                  </a>
                  {o.kind === "stock" && <UiBadge color="green">склад</UiBadge>}
                </div>
                {o.customerOrders.length === 0 && o.invoices.length > 0 && (
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
            title: "Этапы производства",
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
            width: 195,
            align: "right",
            render: (_, o) => (
              <Space wrap size={4}>
                <Button
                  size="middle"
                  style={{ minHeight: 44 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDetailsOrder(o);
                  }}
                >
                  Задания участков
                </Button>
                <Tooltip title="Печать нарядов заказа">
                  <Button
                    size="middle"
                    style={{ minWidth: 44, minHeight: 44 }}
                    icon={<PrinterOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePrintOrder(o);
                    }}
                  />
                </Tooltip>
                <Tooltip title="Открыть полную карточку заказа">
                  <Button
                    size="middle"
                    type="primary"
                    ghost
                    style={{ minHeight: 44 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onOpenOrder) onOpenOrder(o.orderId);
                      else navigate(`/production-orders/${o.orderId}`);
                    }}
                  >
                    Карточка ↗
                  </Button>
                </Tooltip>
              </Space>
            ),
          },
          ]}
        />
      )}
      <Drawer
        open={detailsOrder != null}
        onClose={() => setDetailsOrder(null)}
        title={detailsOrder ? `Задание производства №${detailsOrder.orderId} · задания участков` : null}
        width={Math.min(1120, typeof window !== "undefined" ? window.innerWidth : 1120)}
        destroyOnHidden
        styles={{ body: { padding: 12 } }}
      >
        {detailsOrder && (
          <ExpandedOrderTasks
            order={detailsOrder}
            lines={linesByOrder.get(detailsOrder.orderId) ?? []}
            areaNameMap={areaNameMap}
            onOpenTask={onOpenTask}
            onOpenOrder={onOpenOrder}
            onPrintTasks={onPrintTasks}
          />
        )}
      </Drawer>
    </Space>
  );
}
