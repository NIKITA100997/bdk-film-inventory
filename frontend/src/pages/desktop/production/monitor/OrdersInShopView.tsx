import { useMemo } from "react";
import { Button, Card, Empty, Progress, Space, Table, Tag, Tooltip, Typography, theme } from "antd";
import { ApartmentOutlined, CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, PrinterOutlined, WarningOutlined } from "@ant-design/icons";
import { Link, useNavigate } from "react-router-dom";
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

export interface OrderStageItem {
  key: string;
  label: string;
  plan: number;
  done: number;
  left: number;
  percent: number;
  status: "done" | "in_work" | "pending" | "deficit";
  deficitM?: number;
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
  stages: OrderStageItem[];
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
  onPrintTasks?: (spec: { tasks: PrintableTask[]; title: string }) => void;
}

export default function OrdersInShopView({
  rows,
  orders,
  areas,
  hideDone,
  onOpenTask,
  onPrintTasks,
}: OrdersInShopViewProps) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const areaNameMap = useMemo(() => new Map(areas.map((a) => [a.code, a.name])), [areas]);
  const orderMap = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);

  // Сбор позиций заказа и операций
  const { lines } = useMemo(() => buildLines(rows, orders, areas), [rows, orders, areas]);

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

    // Линии заказов по order_id
    const linesByOrder = new Map<number, LineRec[]>();
    for (const l of lines.values()) {
      const list = linesByOrder.get(l.order_id) ?? [];
      list.push(l);
      linesByOrder.set(l.order_id, list);
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
        // Если заказ без линий дверей (погонаж, наряд) — считаем по строкам заданий
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

      // Расчёт этапов заказа (Stage Pipeline)
      const stages: OrderStageItem[] = [];

      // 1. Каркасы (если есть ПФ каркасов)
      const frameRows = orderRows.filter(
        (r) => r.part_id != null && (/каркас/i.test(r.position) || r.area === "uchastok_sborki_karkasov" || (r.operation || "").toLowerCase().includes("каркас")),
      );
      if (frameRows.length > 0) {
        const plan = frameRows.reduce((s, r) => s + r.plan, 0);
        const done = frameRows.reduce((s, r) => s + doneOf(r), 0);
        const left = Math.max(0, plan - done);
        const pct = plan > 0 ? Math.round((done / plan) * 100) : 100;
        stages.push({
          key: "frames",
          label: "Каркасы",
          plan,
          done,
          left,
          percent: pct,
          status: left <= 0 ? "done" : done > 0 ? "in_work" : "pending",
        });
      }

      // 2. Панели (если есть ПФ панелей / скинов)
      const panelRows = orderRows.filter(
        (r) => r.part_id != null && !/каркас/i.test(r.position),
      );
      if (panelRows.length > 0) {
        const plan = panelRows.reduce((s, r) => s + r.plan, 0);
        const done = panelRows.reduce((s, r) => s + doneOf(r), 0);
        const left = Math.max(0, plan - done);
        const pct = plan > 0 ? Math.round((done / plan) * 100) : 100;
        stages.push({
          key: "panels",
          label: "Панели",
          plan,
          done,
          left,
          percent: pct,
          status: left <= 0 ? "done" : done > 0 ? "in_work" : "pending",
        });
      }

      // 3. Плёнка
      const filmRows = orderRows.filter((r) => r.film || r.film_status != null || (r.film_need_m ?? 0) > 0);
      if (filmRows.length > 0) {
        if (filmDeficitM > 0) {
          stages.push({
            key: "film",
            label: "Плёнка",
            plan: 0,
            done: 0,
            left: 0,
            percent: 0,
            status: "deficit",
            deficitM: filmDeficitM,
          });
        } else {
          const allOk = filmRows.every((r) => r.film_status === "issued" || r.film_status === "covered" || r.film_status === "site_stock");
          stages.push({
            key: "film",
            label: "Плёнка",
            plan: 0,
            done: 0,
            left: 0,
            percent: allOk ? 100 : 50,
            status: allOk ? "done" : "in_work",
          });
        }
      }

      // 4. Операции сборки/склейки/кромки/упаковки
      // Группируем по ключевым операциям
      const mainOpRows = orderRows.filter((r) => r.part_id == null);
      const opsMap = new Map<string, MonitorRow[]>();
      for (const r of mainOpRows) {
        const opName = r.operation ?? areaNameMap.get(r.area) ?? r.area;
        const list = opsMap.get(opName) ?? [];
        list.push(r);
        opsMap.set(opName, list);
      }

      for (const [opName, opRowsList] of opsMap.entries()) {
        const plan = opRowsList.reduce((s, r) => s + r.plan, 0);
        const done = opRowsList.reduce((s, r) => s + doneOf(r), 0);
        const left = Math.max(0, plan - done);
        const pct = plan > 0 ? Math.round((done / plan) * 100) : 100;
        stages.push({
          key: `op-${opName}`,
          label: opName,
          plan,
          done,
          left,
          percent: pct,
          status: left <= 0 ? "done" : done > 0 ? "in_work" : "pending",
        });
      }

      // Определение узкого места (bottleneck)
      let bottleneck = "В графике";
      let bottleneckType: OrderInShopSummary["bottleneckType"] = "ready";

      if (filmDeficitM > 0) {
        bottleneck = `Дефицит плёнки -${r2(filmDeficitM)} м`;
        bottleneckType = "deficit";
      } else {
        const incompleteStage = stages.find((s) => s.status !== "done" && s.key !== "film");
        if (incompleteStage) {
          bottleneck = `${incompleteStage.label}: ${r2(incompleteStage.done)} из ${r2(incompleteStage.plan)} шт`;
          bottleneckType = incompleteStage.done > 0 ? "in_work" : "warning";
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
        stages,
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
  }, [rows, lines, orders, areas, hideDone, orderMap, areaNameMap]);

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
        scroll={{ x: "max-content" }}
        expandable={{
          expandedRowRender: (record) => (
            <div style={{ margin: "4px 0 12px 0", background: "#fafafa", padding: "10px 12px", borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}` }}>
              <Typography.Text strong style={{ display: "block", marginBottom: 8, fontSize: 13 }}>
                📋 Задания и позиции заказа №{record.orderId} «{record.orderName}» ({record.rows.length} строк заданий)
              </Typography.Text>
              <Table<MonitorRow>
                size="small"
                rowKey="task_line_id"
                dataSource={record.rows}
                pagination={false}
                columns={[
                  {
                    title: "Участок",
                    width: 170,
                    render: (_, r) => <UiBadge color="blue">{areaNameMap.get(r.area) ?? r.area}</UiBadge>,
                  },
                  {
                    title: "Операция",
                    width: 150,
                    dataIndex: "operation",
                    render: (op, r) => op || r.area,
                  },
                  {
                    title: "Позиция / Деталь",
                    render: (_, r) => (
                      <div>
                        <b>{posOf(r)}</b>
                        {r.part_id != null && (
                          <UiBadge color="orange" style={{ marginLeft: 6 }}>
                            П/Ф
                          </UiBadge>
                        )}
                        {r.film_deficit_m != null && r.film_deficit_m > 0 && (
                          <Tag color="error" style={{ marginLeft: 6 }}>
                            дефицит -{r2(r.film_deficit_m)} м
                          </Tag>
                        )}
                      </div>
                    ),
                  },
                  {
                    title: "План",
                    width: 70,
                    align: "right",
                    render: (_, r) => r2(r.plan),
                  },
                  {
                    title: "Сделано",
                    width: 90,
                    align: "right",
                    render: (_, r) => (
                      <span>
                        {r2(r.good)}
                        {r.defect > 0 && <Typography.Text type="danger" style={{ fontSize: 11 }}> б{r2(r.defect)}</Typography.Text>}
                      </span>
                    ),
                  },
                  {
                    title: "Осталось",
                    width: 80,
                    align: "right",
                    render: (_, r) =>
                      r.closed ? (
                        <span style={{ color: "#8c8c8c", fontSize: 11 }}>закрыто</span>
                      ) : leftOf(r) > 0 ? (
                        <b style={{ color: token.colorWarning }}>{r2(leftOf(r))}</b>
                      ) : (
                        <span style={{ color: token.colorSuccess, fontSize: 11 }}>готово</span>
                      ),
                  },
                  {
                    title: "Срок",
                    width: 80,
                    render: (_, r) => (r.date_from ? dm(r.date_from) : "—"),
                  },
                  {
                    title: "Плёнка",
                    width: 110,
                    render: (_, r) => {
                      if (!r.film && !r.film_status) return "—";
                      if (r.film_status === "issued" || r.film_status === "covered" || r.film_status === "site_stock") {
                        return <Tag color="green">выдана</Tag>;
                      }
                      if (r.film_status === "partial") return <Tag color="orange">частично</Tag>;
                      return <Tag color="red">не выдана</Tag>;
                    },
                  },
                  {
                    title: "Отчёт в цехе",
                    width: 280,
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
            </div>
          ),
        }}
        columns={[
          {
            title: "Заказ и счета",
            width: 240,
            render: (_, o) => (
              <Space direction="vertical" size={2}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Link
                    to={`/production-orders/${o.orderId}`}
                    style={{ fontWeight: 600, fontSize: 14 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    №{o.orderId} «{o.orderName}»
                  </Link>
                  {o.kind === "stock" && <UiBadge color="green">на склад</UiBadge>}
                </div>
                {o.invoices.length > 0 && (
                  <div style={{ fontSize: 12 }}>
                    Счета:{" "}
                    {o.invoices.map((inv) => (
                      <UiBadge key={inv} color="purple" style={{ marginInlineEnd: 4 }}>
                        {inv}
                      </UiBadge>
                    ))}
                  </div>
                )}
                {o.seriesList.length > 0 && (
                  <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                    Серии: {o.seriesList.join(", ")}
                  </div>
                )}
              </Space>
            ),
          },
          {
            title: "Срок отгрузки",
            width: 140,
            render: (_, o) => {
              if (!o.shipDate) {
                return <Typography.Text type="secondary">без срока</Typography.Text>;
              }
              const d = o.daysLeft ?? 0;
              return (
                <Space direction="vertical" size={2}>
                  <b>{dm(o.shipDate)}</b>
                  {d < 0 ? (
                    <Tag color="error" icon={<WarningOutlined />}>
                      просрочен на {Math.abs(d)} дн.
                    </Tag>
                  ) : d === 0 ? (
                    <Tag color="error" icon={<ClockCircleOutlined />}>
                      сегодня!
                    </Tag>
                  ) : d === 1 ? (
                    <Tag color="warning" icon={<ClockCircleOutlined />}>
                      завтра!
                    </Tag>
                  ) : d <= 2 ? (
                    <Tag color="warning">горит: {d} дн.</Tag>
                  ) : (
                    <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
                      осталось {d} дн.
                    </span>
                  )}
                </Space>
              );
            },
          },
          {
            title: "Текущий статус / Узкое место",
            width: 220,
            render: (_, o) => {
              if (o.bottleneckType === "deficit") {
                return (
                  <Tag color="error" icon={<ExclamationCircleOutlined />} style={{ whiteSpace: "normal" }}>
                    {o.bottleneck}
                  </Tag>
                );
              }
              if (o.bottleneckType === "warning") {
                return (
                  <Tag color="warning" icon={<ClockCircleOutlined />} style={{ whiteSpace: "normal" }}>
                    {o.bottleneck}
                  </Tag>
                );
              }
              if (o.bottleneckType === "in_work") {
                return (
                  <Tag color="processing" icon={<ApartmentOutlined />} style={{ whiteSpace: "normal" }}>
                    {o.bottleneck}
                  </Tag>
                );
              }
              return (
                <Tag color="success" icon={<CheckCircleOutlined />}>
                  {o.bottleneck}
                </Tag>
              );
            },
          },
          {
            title: "Маршрутная цепочка (Этапы цеха)",
            render: (_, o) => (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                {o.stages.map((st) => {
                  const isDone = st.status === "done";
                  const isDeficit = st.status === "deficit";
                  const isInWork = st.status === "in_work";

                  let color = "default";
                  let bg = "#fafafa";
                  let border = "#d9d9d9";
                  let text = `${st.label}: ${r2(st.done)}/${r2(st.plan)}`;

                  if (st.key === "film") {
                    if (isDeficit) {
                      color = "#cf1322";
                      bg = "#fff1f0";
                      border = "#ffa39e";
                      text = `Плёнка: дефицит -${r2(st.deficitM ?? 0)}м`;
                    } else if (isDone) {
                      color = "#389e0d";
                      bg = "#f6ffed";
                      border = "#b7eb8f";
                      text = "Плёнка: выдана ✔";
                    } else {
                      color = "#d46b08";
                      bg = "#fff7e6";
                      border = "#ffd591";
                      text = "Плёнка: частично";
                    }
                  } else if (isDone) {
                    color = "#389e0d";
                    bg = "#f6ffed";
                    border = "#b7eb8f";
                    text = `${st.label}: 100% ✔`;
                  } else if (isInWork) {
                    color = "#0958d9";
                    bg = "#e6f4ff";
                    border = "#91caff";
                  }

                  return (
                    <span
                      key={st.key}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 7px",
                        borderRadius: 4,
                        fontSize: 11,
                        lineHeight: "16px",
                        background: bg,
                        border: `1px solid ${border}`,
                        color: color,
                        fontWeight: isInWork ? 600 : 400,
                      }}
                      title={`${st.label}: план ${r2(st.plan)}, сдано ${r2(st.done)}, осталось ${r2(st.left)}`}
                    >
                      {text}
                    </span>
                  );
                })}
              </div>
            ),
          },
          {
            title: "Готовность",
            width: 170,
            render: (_, o) => (
              <Space direction="vertical" size={2} style={{ width: "100%" }}>
                <Progress
                  percent={o.progressPercent}
                  size="small"
                  status={o.hasDeficit ? "exception" : o.progressPercent >= 100 ? "success" : "active"}
                />
                <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
                  <b>{r2(o.totalDone)}</b> из {r2(o.totalPlan)} шт ({o.progressPercent}%)
                </span>
              </Space>
            ),
          },
          {
            title: "",
            width: 140,
            align: "right",
            render: (_, o) => (
              <Space size={4}>
                <Tooltip title="Распечатать наряды по этому заказу">
                  <Button
                    size="small"
                    icon={<PrinterOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePrintOrder(o);
                    }}
                  />
                </Tooltip>
                <Button
                  size="small"
                  type="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/production-orders/${o.orderId}`);
                  }}
                >
                  Заказ →
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
