import { useMemo, useState } from "react";
import { Button, Card, Checkbox, Input, Segmented, Select, Space, Typography } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
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
import TaskCardDrawer from "./TaskCardDrawer";

// Вид продукции (16.10): у дверей, погонажа и панелей свои этапы — по одному виду.
const PRODUCTS = ["shield", "tsarg", "trim", "panel", "other"] as const;
const productOf = (r: MonitorRow) => (r.direction && (PRODUCTS as readonly string[]).includes(r.direction) ? r.direction : "other");
const productLabel = (p: string) => (p === "other" ? "Прочее" : DIRECTIONS[p] ?? p);
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Монитор производства (переработан 21.10).
 * «Заказы на производство» — как лист «График»: строка на позицию заказа,
 * столбец на операцию (сделано/план, клик — отчёт), осталось упаковать.
 * «Задания цехов» — участок за участком: его строки по всем заказам, отчёт
 * прямо в строке. Быстрый отчёт — где не нужен рулон и дневной план. */
export default function ProductionMonitor() {
  useTabTitle("Монитор производства");
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [showDone, setShowDone] = usePersistentState("monitor.showDone", false);
  const [savedView, setSavedView] = usePersistentState<"orders" | "areas">("monitor.view", "orders");
  const [savedProduct, setSavedProduct] = usePersistentState<string>("monitor.product", "shield");
  const [savedArea, setSavedArea] = usePersistentState<string | undefined>("monitor.area", undefined);
  const view = (params.get("view") as "orders" | "areas") ?? savedView;
  const area = params.get("area") ?? savedArea;
  const [q, setQ] = useState("");
  const [orderIds, setOrderIds] = useState<number[]>([]);
  const [taskId, setTaskId] = useState<number | null>(null);
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
  const productOk = product === "all" || !products.length ? null : products.includes(product as never) ? product : products[0];

  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return (data?.rows ?? []).filter(
      (r) =>
        (!productOk || productOf(r) === productOk) &&
        (orderIds.length === 0 || orderIds.includes(r.order_id ?? 0)) &&
        (!needle ||
          [r.invoice_no ?? "", r.series ?? "", r.color ?? "", r.source ?? "", r.position, r.task_name ?? "", r.operation ?? ""].some((s) =>
            norm(s).includes(needle),
          )),
    );
  }, [data, productOk, orderIds, q]);

  const orderOptions = useMemo(() => {
    const ids = new Set((data?.rows ?? []).filter((r) => !productOk || productOf(r) === productOk).map((r) => r.order_id ?? 0));
    return (data?.orders ?? [])
      .filter((o) => ids.has(o.id))
      .map((o) => ({ value: o.id, label: `№${o.id} «${o.name}»${o.ship_date ? ` · отгрузка ${dayjs(o.ship_date).format("DD.MM")}` : ""}` }));
  }, [data, productOk]);

  const exportOrders = () => {
    const { lines, ops } = buildLines(rows, data?.orders ?? [], data?.areas ?? []);
    const out = lines.map((l) => {
      const rec: Record<string, string | number> = {
        order: l.order_name, launch: l.launch ? dayjs(l.launch).format("DD.MM.YYYY") : "", invoice: l.invoice, series: l.series,
        size: l.size, color: l.color, name: l.source, qty: l.qty, left: l.left,
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
        { key: "order", header: "Заказ" }, { key: "launch", header: "Дата запуска" }, { key: "invoice", header: "№ счёта" },
        { key: "series", header: "Серия" }, { key: "size", header: "Размер" }, { key: "color", header: "Цвет" },
        { key: "name", header: "Наименование" }, { key: "qty", header: "Кол-во" }, { key: "left", header: "Осталось упаковать" },
        ...ops.map((op, i) => ({ key: `op${i}`, header: op })),
      ],
      [`Монитор производства — ${productOk ? productLabel(productOk) : "все"}, ${dayjs().format("DD.MM.YYYY HH:mm")}`],
    );
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small">
        <Space wrap size={[12, 8]}>
          <Segmented
            value={view}
            onChange={(v) => {
              setSavedView(v as "orders" | "areas");
              set({ view: v as string });
            }}
            options={[
              { label: "Заказы на производство", value: "orders" },
              { label: "Задания цехов", value: "areas" },
            ]}
          />
          {products.length > 0 && (
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
            placeholder="Все заказы"
            style={{ minWidth: 240, maxWidth: 460 }}
            value={orderIds}
            onChange={setOrderIds}
            optionFilterProp="label"
            maxTagCount="responsive"
            options={orderOptions}
          />
          <Input.Search allowClear placeholder="Счёт, серия, цвет, позиция" style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Checkbox checked={showDone} onChange={(e) => setShowDone(e.target.checked)}>
            показывать готовые
          </Checkbox>
          <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => query.refetch()}>
            Обновить
          </Button>
          {view === "orders" && (
            <Button icon={<DownloadOutlined />} disabled={!rows.length} onClick={exportOrders}>
              Excel
            </Button>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data ? `обновлено ${dayjs(query.dataUpdatedAt).format("HH:mm")}` : ""}
          </Typography.Text>
        </Space>
      </Card>
      {!data ? null : view === "orders" ? (
        <OrdersView rows={rows} orders={data.orders} areas={data.areas} hideDone={!showDone} onOpenTask={setTaskId} />
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
      <TaskCardDrawer
        taskId={taskId}
        onClose={() => {
          setTaskId(null);
          query.refetch();
        }}
        canManage={hasPerm(user, "production_tasks.manage")}
        canReport={hasPerm(user, "production_tasks.manage", "production_tasks.report")}
      />
    </Space>
  );
}
