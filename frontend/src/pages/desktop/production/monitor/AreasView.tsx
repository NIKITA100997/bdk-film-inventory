import { useMemo, useState } from "react";
import { Button, Card, Empty, Progress, Segmented, Space, Tooltip, Typography, theme } from "antd";
import { AppstoreOutlined, PlusOutlined, UnorderedListOutlined, UploadOutlined } from "@ant-design/icons";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import type { MonitorArea, MonitorOrder, MonitorRow } from "../../../../api/productionMonitor";
import GroupedTable from "../../../../components/GroupedTable";
import { UiBadge } from "../../../../components/UiBadge";
import QuickReport from "./QuickReport";
import { buildLines } from "./OrdersView";
import { computeFlow, opIncludes } from "./flow";
import OrdersInShopView from "./OrdersInShopView";
import { OrderModal } from "../ProductionOrders";
import ScheduleImportModal from "../ScheduleImportModal";
import PrintTasksModal, { type PrintableTask } from "../PrintTasksModal";
import { usePersistentState } from "../../../../hooks/usePersistentState";
import { useAuth } from "../../../../auth/AuthContext";
import { hasPerm } from "../../../../auth/permissions";
import { listProductionOrders } from "../../../../api/productionOrders";

const r2 = (v: number) => Math.round(v * 100) / 100;
const dm = (s: string | null | undefined) => (s ? dayjs(s).format("DD.MM") : "");
const leftOf = (r: MonitorRow) => (r.closed ? 0 : Math.max(0, r.plan - r.good));
const doneOf = (r: MonitorRow) => (r.closed ? r.plan : Math.min(r.good, r.plan));
const posOf = (r: MonitorRow) => (r.part_id == null && (r.series || r.size) ? [r.series, r.size, r.color].filter(Boolean).join(" · ") : r.position);

/** «Участки и заказы»: объединённый цеховой центр управления.
 * - Режим «По участкам»: плитки участков, таблица заданий участка с быстрым отчётом.
 * - Режим «По заказам в цехе»: сводный пайплайн движения заказов по этапам цеха,
 *   узкие места, сроки сдачи и детальные строки заданий каждого заказа. */
export default function AreasView({
  rows,
  orders,
  areas,
  area,
  onArea,
  hideDone,
  onOpenTask,
  onOpenOrder,
}: {
  rows: MonitorRow[];
  orders: MonitorOrder[];
  areas: MonitorArea[];
  area: string | undefined;
  onArea: (code: string) => void;
  hideDone: boolean;
  onOpenTask: (id: number) => void;
  onOpenOrder?: (id: number) => void;
}) {
  const { token } = theme.useToken();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canManage = hasPerm(user, "production_tasks.manage");

  // Режим просмотра: по участкам или по заказам
  const [mode, setMode] = usePersistentState<"areas" | "orders">("monitor.areas.mode", "areas");

  // Модальные окна управления
  const [newOrderOpen, setNewOrderOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [printOrderTasks, setPrintOrderTasks] = useState<{ tasks: PrintableTask[]; title: string } | null>(null);

  // Счётчик черновиков к запуску
  const draftsQuery = useQuery({
    queryKey: ["production-orders-drafts-count"],
    queryFn: () => listProductionOrders(false),
    staleTime: 60_000,
  });
  const draftsCount = useMemo(
    () => (draftsQuery.data ?? []).filter((o) => o.status === "draft").length,
    [draftsQuery.data]
  );

  const orderName = useMemo(() => new Map(orders.map((o) => [o.id, `№${o.id} «${o.name}»`])), [orders]);

  const stats = useMemo(() => {
    const m = new Map<string, { plan: number; done: number; left: number; open: number; quick: boolean }>();
    for (const r of rows) {
      const s = m.get(r.area) ?? { plan: 0, done: 0, left: 0, open: 0, quick: false };
      s.plan += r.plan;
      s.done += doneOf(r);
      s.left += leftOf(r);
      if (leftOf(r) > 0) s.open += 1;
      s.quick ||= !!r.quick;
      m.set(r.area, s);
    }
    return m;
  }, [rows]);

  // Число уникальных заказов в текущих строках
  const uniqueOrderIds = useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) {
      if (r.order_id != null) set.add(r.order_id);
    }
    return Array.from(set);
  }, [rows]);

  // поток: по участку двери — готово к передаче / в работе
  const flowByArea = useMemo(() => {
    const { lines, ops } = buildLines(rows, orders, areas);
    const flow = computeFlow(lines, ops);
    const opArea = new Map<string, string>();
    for (const r of rows) if (r.part_id == null && r.order_line_id != null) opArea.set(r.operation ?? r.area, r.area);
    const m = new Map<string, { ready: number; inWork: number; first: boolean; inc?: string }>();
    flow.ops.forEach((f, i) => {
      const code = opArea.get(f.op);
      if (!code) return;
      const cur = m.get(code) ?? { ready: 0, inWork: 0, first: i === 0, inc: opIncludes(f.op) };
      cur.ready += f.ready;
      cur.inWork += f.inWork;
      m.set(code, cur);
    });
    return m;
  }, [rows, orders, areas]);

  const used = useMemo(() => {
    const presentAreas = areas.filter((a) => stats.has(a.code));
    for (const code of stats.keys()) {
      if (!presentAreas.some((a) => a.code === code)) {
        presentAreas.push({
          code,
          name: code,
          site: "Цех",
          sort: 99,
          per_day: null,
        });
      }
    }
    return presentAreas.sort((a, b) => (a.sort ?? 99) - (b.sort ?? 99));
  }, [areas, stats]);

  const sites = useMemo(() => [...new Set(used.map((a) => a.site ?? "Без площадки"))], [used]);
  const cur = area && stats.has(area) ? area : used[0]?.code;
  const data = useMemo(
    () => rows.filter((r) => r.area === cur && (!hideDone || leftOf(r) > 0)),
    [rows, cur, hideDone],
  );

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {/* Верхняя плашка переключения режима и быстрых действий */}
      <Card size="small" bodyStyle={{ padding: "8px 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Segmented
            value={mode}
            onChange={(m) => setMode(m as "areas" | "orders")}
            options={[
              {
                label: (
                  <Space size={6}>
                    <AppstoreOutlined />
                    <span>По участкам ({used.length})</span>
                  </Space>
                ),
                value: "areas",
              },
              {
                label: (
                  <Space size={6}>
                    <UnorderedListOutlined />
                    <span>По заказам в цехе ({uniqueOrderIds.length})</span>
                  </Space>
                ),
                value: "orders",
              },
            ]}
          />

          <Space wrap size={8}>
            {canManage && (
              <>
                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setNewOrderOpen(true)}>
                  Новый заказ
                </Button>
                <Button size="small" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
                  Импорт графика
                </Button>
              </>
            )}
            {draftsCount > 0 && (
              <Tooltip title="Черновики заказов, готовые к настройке и запуску на участки">
                <Link to="/customer-orders?tab=production">
                  <UiBadge color="gold">
                    ⏳ Черновиков к запуску: {draftsCount}
                  </UiBadge>
                </Link>
              </Tooltip>
            )}
            <Button size="small" type="link" onClick={() => navigate("/production-orders")}>
              Все заказы и архив →
            </Button>
          </Space>
        </div>
      </Card>

      {/* Тело экрана: режим «По заказам» или режим «По участкам» */}
      {mode === "orders" ? (
        <OrdersInShopView
          rows={rows}
          orders={orders}
          areas={areas}
          hideDone={hideDone}
          onOpenTask={onOpenTask}
          onOpenOrder={onOpenOrder}
          onPrintTasks={setPrintOrderTasks}
        />
      ) : !used.length ? (
        <Empty description="Открытых заданий нет" />
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {sites.map((site) => (
            <div key={site} style={{ display: "grid", gap: 6 }}>
              <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase" }}>
                {site}
              </Typography.Text>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
                {used
                  .filter((a) => (a.site ?? "Без площадки") === site)
                  .map((a) => {
                    const s = stats.get(a.code)!;
                    const on = a.code === cur;
                    const pct = s.plan ? Math.round((s.done / s.plan) * 100) : 100;
                    return (
                      <button
                        key={a.code}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onArea(a.code)}
                        style={{
                          textAlign: "left",
                          padding: "8px 10px",
                          borderRadius: 8,
                          cursor: "pointer",
                          font: "inherit",
                          color: "inherit",
                          border: `1px solid ${on ? token.colorPrimary : token.colorBorderSecondary}`,
                          background: on ? token.colorPrimaryBg : token.colorBgContainer,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                          <span style={{ fontWeight: on ? 600 : 500 }}>{a.name}</span>
                          <span style={{ fontSize: 11, fontWeight: 600, color: pct >= 100 ? token.colorSuccess : token.colorPrimary }}>
                            {pct}%
                          </span>
                        </div>
                        {flowByArea.get(a.code)?.inc && (
                          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>вкл.: {flowByArea.get(a.code)!.inc}</div>
                        )}
                        <div style={{ fontSize: 12, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                          Сдано: <b>{r2(s.done)}</b> / {r2(s.plan)} шт
                        </div>
                        {flowByArea.has(a.code) && (
                          <div style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", color: token.colorTextSecondary }}>
                            <span style={{ color: token.colorSuccess }}>ждёт: {r2(flowByArea.get(a.code)!.ready)}</span>
                            {" · "}
                            <span style={{ color: token.colorWarning }}>
                              {flowByArea.get(a.code)!.first ? "к запуску" : "в работе"}: {r2(flowByArea.get(a.code)!.inWork)}
                            </span>
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: token.colorTextSecondary, marginTop: 2 }}>
                          осталось {r2(s.left)} шт · строк {s.open}
                          {!s.quick && (
                            <span style={{ marginLeft: 6, fontSize: 10, background: "#f0f0f0", color: "#595959", padding: "1px 5px", borderRadius: 3 }}>
                              отчёт в задании
                            </span>
                          )}
                        </div>
                        <Progress percent={pct} size="small" showInfo={false} strokeColor={pct >= 100 ? token.colorSuccess : token.colorPrimary} />
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
          <GroupedTable<MonitorRow>
            key={cur}
            storageKey="monitor.area"
            dims={[
              { key: "order", label: "Заказ", value: (r) => (r.order_id != null ? orderName.get(r.order_id) ?? `№${r.order_id}` : r.task_name ?? "") },
              { key: "invoice", label: "Счёт / серия", value: (r) => r.source_orders?.length ? r.source_orders.map((s) => `${s.invoice_no ?? "—"} / ${s.series || "—"} (${r2(s.quantity_pieces)})`).join(", ") : r.invoice_no ?? "" },
              { key: "op", label: "Операция", value: (r) => r.operation ?? "" },
              { key: "pos", label: "Позиция", value: (r) => posOf(r) },
            ]}
            defaultDims={["order"]}
            labelColumn="pos"
            size="small"
            rowKey={(r) => String(r.task_line_id)}
            dataSource={data}
            pagination={false}
            scroll={{ x: 970, y: "calc(100vh - 420px)" }}
            exportTitle={`Монитор: ${used.find((a) => a.code === cur)?.name ?? cur}`}
            columns={[
              {
                key: "pos",
                title: "Позиция",
                width: 210,
                sortValue: posOf,
                render: (_, r) => (
                  <div style={{ maxWidth: 210 }}>
                    <Tooltip title={posOf(r)}>
                      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {posOf(r)}
                      </div>
                    </Tooltip>
                    {r.film_deficit_m != null && r.film_deficit_m > 0 && (
                      <span style={{ display: "inline-block", fontSize: 11, marginTop: 2, background: "#fff1f0", color: "#cf1322", border: "1px solid #ffa39e", borderRadius: 3, padding: "0 4px" }}>
                        дефицит -{r2(r.film_deficit_m)} м
                      </span>
                    )}
                    {r.part_id == null && r.source && (
                      <Tooltip title={r.source}>
                        <div style={{ fontSize: 11, color: "#8c8c8c", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.source}
                        </div>
                      </Tooltip>
                    )}
                    {r.source_missing && (
                      <div style={{ fontSize: 11, color: "#ff4d4f" }}>
                        Требуется сверка
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: "invoice",
                title: "Счёт / серия",
                width: 130,
                sortValue: (r) => r.invoice_no ?? "",
                render: (_, r) =>
                  r.source_orders?.length ? (
                    <div style={{ fontSize: 12 }}>
                      {r.source_orders!.map((s) => (
                        <div key={s.order_line_id} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${s.invoice_no ?? "—"} / ${s.series || "—"} (${r2(s.quantity_pieces)} шт)`}>
                          {s.invoice_no ?? "—"} / {s.series || "—"} ({r2(s.quantity_pieces)})
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.invoice_no ?? "—"}
                    </div>
                  ),
              },
              { key: "op", title: "Операция", width: 110, sortValue: (r) => r.operation ?? "", render: (_, r) => <span style={{ fontSize: 12 }}>{r.operation ?? ""}</span> },
              {
                key: "plan",
                title: "План",
                width: 60,
                align: "right",
                sortValue: (r) => r.plan,
                render: (_, r) => r2(r.plan),
                groupRender: (rs) => r2(rs.reduce((s, r) => s + r.plan, 0)),
              },
              {
                key: "done",
                title: "Сделано",
                width: 70,
                align: "right",
                sortValue: (r) => doneOf(r),
                render: (_, r) => (
                  <span>
                    {r2(r.good)}
                    {r.defect > 0 && <Typography.Text type="danger" style={{ fontSize: 11 }}> б{r2(r.defect)}</Typography.Text>}
                  </span>
                ),
                groupRender: (rs) => r2(rs.reduce((s, r) => s + doneOf(r), 0)),
              },
              {
                key: "left",
                title: "Осталось",
                width: 70,
                align: "right",
                sortValue: leftOf,
                render: (_, r) =>
                  r.closed ? (
                    <span style={{ color: "#8c8c8c", fontSize: 11, background: "#f5f5f5", padding: "1px 5px", borderRadius: 3 }}>
                      закр
                    </span>
                  ) : leftOf(r) > 0 ? (
                    <b>{r2(leftOf(r))}</b>
                  ) : (
                    <span style={{ color: "#389e0d", fontSize: 11, background: "#f6ffed", border: "1px solid #b7eb8f", padding: "1px 5px", borderRadius: 3 }}>
                      готов
                    </span>
                  ),
                groupRender: (rs) => <b>{r2(rs.reduce((s, r) => s + leftOf(r), 0))}</b>,
              },
              {
                key: "date",
                title: "Срок",
                width: 70,
                sortValue: (r) => r.date_from ?? "",
                render: (_, r) => (r.date_from ? <span style={{ fontSize: 12 }}>{r.date_to && r.date_to !== r.date_from ? `${dm(r.date_from)}–${dm(r.date_to)}` : dm(r.date_from)}</span> : ""),
              },
              {
                key: "report",
                title: "Отчёт",
                width: 250,
                render: (_, r) =>
                  r.quick && leftOf(r) >= 0 ? (
                    <QuickReport row={r} compact />
                  ) : (
                    <Button
                      size="small"
                      title={r.closed ? "Строка закрыта" : "Отчёт в задании"}
                      onClick={() => onOpenTask(r.task_id)}
                    >
                      Задание №{r.task_id}
                    </Button>
                  ),
              },
            ]}
          />
        </Space>
      )}

      {/* Модальные окна управления заказами */}
      {newOrderOpen && (
        <OrderModal
          order={null}
          onClose={() => setNewOrderOpen(false)}
          onSaved={(o) => {
            setNewOrderOpen(false);
            qc.invalidateQueries({ queryKey: ["production-monitor"] });
            qc.invalidateQueries({ queryKey: ["production-orders-drafts-count"] });
            if (onOpenOrder) onOpenOrder(o.id);
            else navigate(`/production-orders/${o.id}`);
          }}
        />
      )}

      {importOpen && (
        <ScheduleImportModal
          onClose={() => setImportOpen(false)}
          onCreated={(order) => {
            setImportOpen(false);
            qc.invalidateQueries({ queryKey: ["production-monitor"] });
            qc.invalidateQueries({ queryKey: ["production-orders-drafts-count"] });
            if (onOpenOrder) onOpenOrder(order.id);
            else navigate(`/production-orders/${order.id}`);
          }}
        />
      )}

      {printOrderTasks && (
        <PrintTasksModal
          tasks={printOrderTasks.tasks}
          title={printOrderTasks.title}
          onClose={() => setPrintOrderTasks(null)}
        />
      )}
    </Space>
  );
}
