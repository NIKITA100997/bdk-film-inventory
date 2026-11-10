import { useMemo, useState } from "react";
import { Button, Card, Checkbox, DatePicker, Input, Radio, Segmented, Select, Space, Tooltip } from "antd";
import { DownloadOutlined, FullscreenExitOutlined, FullscreenOutlined, PrinterOutlined, ReloadOutlined } from "@ant-design/icons";
import PrintTasksModal, { type PrintableTask } from "./PrintTasksModal";
import ProductionOrders from "./ProductionOrders";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { getProductionMonitor, type MonitorRow } from "../../../api/productionMonitor";
import { DIRECTIONS } from "../../../utils/itemAttrs";
import { exportToExcel } from "../../../utils/excel";
import { useTabTitle } from "../../../layout/tabTitle";
import { usePersistentState } from "../../../hooks/usePersistentState";
import { useAuth } from "../../../auth/AuthContext";
import { hasPerm } from "../../../auth/permissions";
import OrdersView, { buildLines } from "./monitor/OrdersView";
import AreasView from "./monitor/AreasView";
import PrepView from "./monitor/PrepView";
import TaskCardDrawer from "./TaskCardDrawer";

// Вид продукции: у дверей, погонажа и панелей свои этапы
const PRODUCTS = ["shield", "tsarg", "trim", "panel", "other"] as const;
const productOf = (r: MonitorRow) => (r.direction && (PRODUCTS as readonly string[]).includes(r.direction) ? r.direction : "other");
const productLabel = (p: string) => (p === "other" ? "Прочее" : DIRECTIONS[p] ?? p);
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
type View = "orders" | "prod_orders" | "areas" | "prep";
type StatusFilter = "all" | "in_work" | "deficit" | "ready";

export default function ProductionMonitor() {
  useTabTitle("Монитор производства");
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [showDone, setShowDone] = usePersistentState("monitor.showDone", false);
  const [savedView, setSavedView] = usePersistentState<View>("monitor.view", "orders");
  const [savedProduct, setSavedProduct] = usePersistentState<string>("monitor.product", "shield");
  const [savedArea, setSavedArea] = usePersistentState<string | undefined>("monitor.area", undefined);
  const view = (params.get("view") as View) ?? savedView;
  const area = params.get("area") ?? savedArea;

  const [q, setQ] = useState("");
  const [orderIds, setOrderIds] = useState<number[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [printOpen, setPrintOpen] = useState(false);

  const query = useQuery({
    queryKey: ["production-monitor", showDone],
    queryFn: () => getProductionMonitor(showDone),
    refetchInterval: 120_000,
  });
  const data = query.data;

  const set = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v == null ? p.delete(k) : p.set(k, v));
    setParams(p, { replace: true });
  };

  const products = PRODUCTS.filter((p) => (data?.rows ?? []).some((r) => productOf(r) === p));
  const product = params.get("product") ?? (view === "areas" ? "all" : savedProduct);
  const productOk = view === "prep" || product === "all" || !products.length ? null : products.includes(product as never) ? product : products[0];

  const orderMap = useMemo(() => new Map((data?.orders ?? []).map((o) => [o.id, o])), [data?.orders]);

  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return (data?.rows ?? []).filter((r) => {
      // 1. Фильтр направления
      if (productOk && productOf(r) !== productOk) return false;

      // 2. Фильтр по выбранным заказам
      if (orderIds.length > 0 && !orderIds.includes(r.order_id ?? 0)) return false;

      // 2b. Фильтр по серии / изделию
      if (selectedSeries.length > 0) {
        const matches = selectedSeries.some((val) => {
          if (val.startsWith("series:")) {
            const ser = val.slice(7).toLowerCase();
            const rSer = (r.series ?? "").toLowerCase();
            if (rSer.includes(ser)) return true;
            return (r.source_orders ?? []).some((src) => (src.series ?? "").toLowerCase().includes(ser));
          } else if (val.startsWith("item:")) {
            const itm = val.slice(5).toLowerCase();
            const pos = (r.position ?? "").toLowerCase();
            const src = (r.source ?? "").toLowerCase();
            return pos.includes(itm) || src.includes(itm);
          }
          return false;
        });
        if (!matches) return false;
      }

      // 3. Фильтр по диапазону дат отгрузки заказа
      if (dateRange && dateRange[0] && dateRange[1] && r.order_id) {
        const order = orderMap.get(r.order_id);
        if (order?.ship_date) {
          const ship = dayjs(order.ship_date);
          if (ship.isBefore(dateRange[0], "day") || ship.isAfter(dateRange[1], "day")) {
            return false;
          }
        }
      }

      // 4. Быстрый фильтр по статусу строки
      if (statusFilter === "in_work") {
        if (r.closed || r.good >= r.plan) return false;
      } else if (statusFilter === "deficit") {
        const hasDeficit = (r.film_deficit_m ?? 0) > 0 || r.film_status === "partial" || r.film_status === "none";
        if (!hasDeficit) return false;
      }

      // 5. Текстовый поиск по всем ключевым полям
      if (needle) {
        const orderName = r.order_id ? orderMap.get(r.order_id)?.name ?? "" : "";
        const searchPool = [
          r.invoice_no ?? "",
          r.series ?? "",
          orderName,
          ...(r.source_orders ?? []).map((src) => `${src.invoice_no ?? ""} ${src.series}`),
          r.color ?? "",
          r.color_name ?? "",
          r.mat_name ?? "",
          r.source ?? "",
          r.position,
          r.task_name ?? "",
          r.operation ?? "",
        ];
        if (!searchPool.some((s) => norm(s).includes(needle))) return false;
      }

      return true;
    });
  }, [data, productOk, orderIds, selectedSeries, dateRange, statusFilter, q, orderMap]);

  const printableTasks = useMemo(() => {
    const map = new Map<number, PrintableTask>();
    const areaMap = new Map((data?.areas ?? []).map((a) => [a.code, a.name]));
    for (const r of rows) {
      if (r.task_id && !r.closed) {
        map.set(r.task_id, { id: r.task_id, area: r.area, area_name: areaMap.get(r.area) ?? r.area });
      }
    }
    return [...map.values()];
  }, [rows, data?.areas]);

  const orderOptions = useMemo(() => {
    const ids = new Set((data?.rows ?? []).filter((r) => !productOk || productOf(r) === productOk).map((r) => r.order_id ?? 0));
    return (data?.orders ?? [])
      .filter((o) => ids.has(o.id) && o.has_lines !== false)
      .map((o) => ({
        value: o.id,
        label: `№${o.id} «${o.name}»${o.ship_date ? ` · отгрузка ${dayjs(o.ship_date).format("DD.MM")}` : ""}`,
      }));
  }, [data, productOk]);

  const itemOrSeriesOptions = useMemo(() => {
    const seriesSet = new Set<string>();
    const itemSet = new Set<string>();
    for (const r of data?.rows ?? []) {
      if (productOk && productOf(r) !== productOk) continue;
      if (r.series && r.series.trim()) {
        r.series.split(",").forEach((s) => {
          const t = s.trim();
          if (t) seriesSet.add(t);
        });
      }
      for (const src of r.source_orders ?? []) {
        if (src.series && src.series.trim()) {
          seriesSet.add(src.series.trim());
        }
      }
      if (r.order_line_id != null && !r.part_id && r.position) {
        // Извлекаем базовое имя изделия без размера (например, "Дверь щитовая Г-40")
        const cleanName = r.position.replace(/\s*\d{3,4}\s*[хx*×]\s*\d{3,4}.*$/i, "").trim();
        if (cleanName && cleanName.length > 2) itemSet.add(cleanName);
      }
    }
    const seriesList = Array.from(seriesSet).sort((a, b) => a.localeCompare(b, "ru"));
    const itemsList = Array.from(itemSet).sort((a, b) => a.localeCompare(b, "ru"));

    const groups: { label: string; options: { value: string; label: string }[] }[] = [];
    if (seriesList.length > 0) {
      groups.push({
        label: `Серии (${seriesList.length})`,
        options: seriesList.map((s) => ({ value: `series:${s}`, label: s })),
      });
    }
    if (itemsList.length > 0) {
      groups.push({
        label: `Изделия (${itemsList.length})`,
        options: itemsList.map((it) => ({ value: `item:${it}`, label: it })),
      });
    }
    return groups;
  }, [data, productOk]);

  const exportOrders = () => {
    const { lines, ops } = buildLines(rows, data?.orders ?? [], data?.areas ?? []);
    const out = lines.map((l) => {
      const rec: Record<string, string | number> = {
        order: l.order_name,
        launch: l.launch ? dayjs(l.launch).format("DD.MM.YYYY") : "",
        invoice: l.invoice,
        series: l.series,
        size: l.size,
        color: l.color,
        name: l.source,
        qty: l.qty,
        left: l.left,
        pf: `${l.pf.readySets}/${l.pf.totalSets}`,
      };
      ops.forEach((op, i) => {
        const rs = l.ops[op] ?? [];
        rec[`op${i}`] = rs.length ? rs.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0) : "";
      });
      return rec;
    });
    exportToExcel(
      `Монитор ${productOk ? productLabel(productOk) : ""} ${dayjs().format("DD.MM.YYYY")}`,
      out,
      [
        { key: "order", header: "Заказ" },
        { key: "launch", header: "Дата запуска" },
        { key: "invoice", header: "№ счёта" },
        { key: "series", header: "Серия" },
        { key: "size", header: "Размер" },
        { key: "color", header: "Цвет" },
        { key: "name", header: "Наименование" },
        { key: "qty", header: "Кол-во" },
        { key: "left", header: "Осталось" },
        { key: "pf", header: "Готовность п/ф (компл)" },
        ...ops.map((op, i) => ({ key: `op${i}`, header: op })),
      ],
      [`Монитор производства — ${productOk ? productLabel(productOk) : "все"}, ${dayjs().format("DD.MM.YYYY HH:mm")}`],
    );
  };

  const containerStyle: React.CSSProperties = isFullscreen
    ? {
        position: "fixed",
        inset: 0,
        zIndex: 1050,
        backgroundColor: "#f5f5f5",
        padding: "10px 16px",
        overflowY: "auto",
        height: "100vh",
        width: "100vw",
      }
    : { width: "100%" };

  return (
    <div style={containerStyle}>
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        {/* Панель фильтров и управления */}
        <Card size="small" bodyStyle={{ padding: "8px 12px" }}>
          <Space wrap size={[10, 8]} style={{ width: "100%", justifyContent: "space-between" }}>
            <Space wrap size={[10, 8]}>
              <Segmented
                value={view}
                onChange={(v) => {
                  setSavedView(v as View);
                  set({ view: v as string });
                }}
                options={[
                  { label: "Матрица по заказам", value: "orders" },
                  { label: "Заказы в цехе", value: "prod_orders" },
                  { label: "Задания цехов", value: "areas" },
                  { label: "Подготовка к склейке", value: "prep" },
                ]}
              />

              {products.length > 0 && view !== "prep" && (
                <Segmented
                  value={productOk ?? "all"}
                  onChange={(v) => {
                    if (v !== "all") setSavedProduct(v as string);
                    set({ product: v as string });
                  }}
                  options={[
                    ...(view === "areas" ? [{ label: "Все", value: "all" }] : []),
                    ...products.map((p) => ({ label: productLabel(p), value: p })),
                  ]}
                />
              )}

              <Select
                mode="multiple"
                allowClear
                placeholder="Фильтр по заказам"
                style={{ minWidth: 190, maxWidth: 300 }}
                value={orderIds}
                onChange={setOrderIds}
                optionFilterProp="label"
                maxTagCount="responsive"
                options={orderOptions}
              />

              <Select
                mode="multiple"
                allowClear
                placeholder="Изделие / Серия"
                style={{ minWidth: 190, maxWidth: 300 }}
                value={selectedSeries}
                onChange={setSelectedSeries}
                optionFilterProp="label"
                maxTagCount="responsive"
                options={itemOrSeriesOptions}
              />

              <DatePicker.RangePicker
                placeholder={["Отгрузка с", "по"]}
                format="DD.MM"
                value={dateRange}
                onChange={(dates) => setDateRange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)}
                style={{ width: 190 }}
                allowClear
              />

              <Input.Search
                allowClear
                placeholder="Счёт, клиент, серия, цвет..."
                style={{ width: 220 }}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />

              <Radio.Group
                size="small"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                optionType="button"
                buttonStyle="solid"
              >
                <Radio.Button value="all">Все</Radio.Button>
                <Radio.Button value="in_work">В работе</Radio.Button>
                <Radio.Button value="deficit">Дефицит плёнки</Radio.Button>
              </Radio.Group>

              <Checkbox checked={showDone} onChange={(e) => setShowDone(e.target.checked)}>
                показывать готовые
              </Checkbox>
            </Space>

            <Space size={6} wrap>
              <Tooltip title={isFullscreen ? "Выйти из полноэкранного режима" : "Развернуть монитор на весь экран для удобного обзора"}>
                <Button
                  icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                  type={isFullscreen ? "primary" : "default"}
                  onClick={() => setIsFullscreen(!isFullscreen)}
                >
                  {isFullscreen ? "Обычный экран" : "Во весь экран"}
                </Button>
              </Tooltip>

              <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => query.refetch()}>
                Обновить
              </Button>

              {view === "orders" && (
                <Button icon={<DownloadOutlined />} disabled={!rows.length} onClick={exportOrders}>
                  Excel
                </Button>
              )}

              <Button
                icon={<PrinterOutlined />}
                disabled={!printableTasks.length}
                onClick={() => setPrintOpen(true)}
                title="Пакетная печать нарядов"
              >
                Печать нарядов {printableTasks.length ? `(${printableTasks.length})` : ""}
              </Button>
            </Space>
          </Space>
        </Card>

        {/* Тело монитора */}
        {!data ? null : view === "prep" ? (
          <PrepView rows={rows} orders={data.orders} areas={data.areas} hideDone={!showDone} onOpenTask={setTaskId} />
        ) : view === "orders" ? (
          <OrdersView rows={rows} orders={data.orders} areas={data.areas} hideDone={!showDone} onOpenTask={setTaskId} />
        ) : view === "prod_orders" ? (
          <ProductionOrders />
        ) : (
          <AreasView
            rows={rows}
            orders={data.orders}
            areas={data.areas}
            area={area ?? undefined}
            onArea={(code) => {
              setSavedArea(code);
              set({ area: code });
            }}
            hideDone={!showDone}
            onOpenTask={setTaskId}
          />
        )}

        {/* Просторная карточка задания для начальника производства */}
        <TaskCardDrawer
          taskId={taskId}
          onClose={() => {
            setTaskId(null);
            query.refetch();
          }}
          canManage={hasPerm(user, "production_tasks.manage")}
          canReport={hasPerm(user, "production_tasks.manage", "production_tasks.report")}
        />

        {printOpen && (
          <PrintTasksModal
            tasks={printableTasks}
            title={orderIds.length === 1 ? `Наряды заказа №${orderIds[0]}` : `Наряды цеха (${printableTasks.length} заданий)`}
            onClose={() => setPrintOpen(false)}
          />
        )}
      </Space>
    </div>
  );
}
