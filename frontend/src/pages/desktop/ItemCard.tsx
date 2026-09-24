import { useEffect, useState } from "react";
import dayjs from "dayjs";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Card, Empty, Progress, Result, Space, Spin, Table, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { ITEM_VIEW_PERMISSIONS, getTechCard, lookupItem } from "../../api/items";
import { ORDER_STATUS_LABEL, listProductionOrders, type ProductionOrder } from "../../api/productionOrders";
import TechCardView from "./nomenclature/TechCardView";
import MaterialCard, { type MaterialCardPrefill } from "./MaterialCard";
import PartCard from "./production/PartCard";

const KIND_COLOR: Record<string, string> = { plenka: "blue", pf: "orange", izdelie: "green" };

/** Карточка позиции (единая модель) — одна на любой вид номенклатуры:
 *  • «Склад» — остатки и действия по виду: у плёнки — рулоны и штрипсы
 *    (прежняя карточка материала), у детали п/ф — партии (карточка детали);
 *  • «Техкарта» — тип и свойства, маршрут, состав, где используется;
 *  • «Заказы» — заказы на производство, где есть позиция.
 * Вкладка — в адресе (?tab=). */
export default function ItemCard() {
  const { id } = useParams();
  const itemId = Number(id);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const cardQuery = useQuery({ queryKey: ["techcard", itemId], queryFn: () => getTechCard(itemId), enabled: itemId > 0 });
  const has = (code: string) => !!user?.is_superuser || !!user?.permissions.includes(code);
  // Заказы — только не у плёнки и тем, кто видит заказы на производство.
  const canSeeOrders = has("production_tasks.manage") || has("production_tasks.view") || has("production_tasks.report");
  const ordersQuery = useQuery({
    queryKey: ["production-orders", "item", itemId],
    queryFn: () => listProductionOrders(true, itemId),
    enabled: itemId > 0 && canSeeOrders && !!cardQuery.data && cardQuery.data.kind_code !== "plenka",
  });
  const card = cardQuery.data;

  if (cardQuery.isLoading) return <Spin style={{ display: "block", margin: 48 }} />;
  if (!card) return <Result status="404" title="Позиция не найдена" extra={<Button onClick={() => navigate("/nomenclature")}>К номенклатуре</Button>} />;

  const stockTab =
    card.source_type === "sku" && card.material && card.color
      ? { key: "stock", label: "Склад", children: <MaterialCard prefill={{ material: card.material, color: card.color, thickness: card.thickness ?? undefined }} /> }
      : card.source_type === "part" && card.source_id && (has("part_units.view") || has("part_units.manage"))
        ? { key: "stock", label: "Склад", children: <PartCard partId={card.source_id} /> }
        : null;
  const orders = ordersQuery.data ?? [];
  const tabs = [
    ...(stockTab ? [stockTab] : []),
    { key: "techcard", label: "Техкарта", children: <TechCardView itemId={itemId} /> },
    ...(card.kind_code !== "plenka" && canSeeOrders
      ? [{ key: "orders", label: `Заказы${orders.length ? ` (${orders.length})` : ""}`, children: <OrdersOfItem itemId={itemId} orders={orders} loading={ordersQuery.isLoading} /> }]
      : []),
  ];
  const active = tabs.some((t) => t.key === params.get("tab")) ? (params.get("tab") as string) : tabs[0].key;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small">
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <a onClick={() => navigate("/nomenclature")}>Номенклатура</a> / карточка позиции
          </Typography.Text>
          <Space wrap align="center">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {card.name}
            </Typography.Title>
            <Tag color={KIND_COLOR[card.kind_code]}>{card.kind_name}</Tag>
            {card.type_name && <Tag color="purple">{card.type_name}</Tag>}
            {!card.is_active && <Tag>архив</Tag>}
          </Space>
        </Space>
      </Card>
      <Tabs activeKey={active} onChange={(k) => setParams({ tab: k })} items={tabs} destroyOnHidden />
    </Space>
  );
}

function OrdersOfItem({ itemId, orders, loading }: { itemId: number; orders: ProductionOrder[]; loading: boolean }) {
  const navigate = useNavigate();
  if (!loading && orders.length === 0) return <Empty description="В заказах на производство позиции пока нет" />;
  return (
    <Table<ProductionOrder>
      size="small"
      rowKey="id"
      loading={loading}
      pagination={false}
      dataSource={orders}
      onRow={() => ({ onClick: () => navigate("/production-orders"), style: { cursor: "pointer" } })}
      columns={[
        { title: "Заказ", render: (_, o) => `№${o.id} «${o.name}»` },
        { title: "Статус", render: (_, o) => <Tag>{ORDER_STATUS_LABEL[o.status]}</Tag> },
        { title: "Отгрузка", render: (_, o) => (o.ship_date ? dayjs(o.ship_date).format("DD.MM.YYYY") : "—") },
        {
          title: "Этой позиции",
          render: (_, o) => {
            const lines = o.lines.filter((l) => l.item_id === itemId);
            const qty = lines.reduce((s, l) => s + l.quantity, 0);
            const done = lines.reduce((s, l) => s + Math.min(l.done, l.quantity), 0);
            return o.status === "draft" ? (
              `${qty} шт`
            ) : (
              <Space size={8}>
                <Progress percent={qty ? Math.round((done / qty) * 100) : 0} size="small" style={{ width: 100 }} />
                <span>
                  {done} из {qty}
                </span>
              </Space>
            );
          },
        },
      ]}
    />
  );
}

/** Прежний адрес карточки детали (/part-card со state.partId) — ведёт в
 * карточку позиции на вкладку «Склад»; не нашлась позиция — прежняя карточка. */
export function PartCardRedirect() {
  const location = useLocation();
  const partId = (location.state as { partId?: number } | null)?.partId;
  const [target, setTarget] = useState<number | null | "fallback">(null);
  useEffect(() => {
    if (!partId) {
      setTarget("fallback");
      return;
    }
    lookupItem({ part_id: partId })
      .then(setTarget)
      .catch(() => setTarget("fallback"));
  }, [partId]);
  if (target === null) return <Spin style={{ display: "block", margin: 48 }} />;
  if (target === "fallback") return <PartCard />;
  return <Navigate to={`/item/${target}?tab=stock`} replace />;
}

/** Прежний адрес карточки материала (/materials со state материал+цвет) —
 * ведёт в карточку позиции на вкладку «Склад». Нет прав на карточку
 * позиции или не нашлась позиция — прежняя карточка, доступ не теряется. */
export function MaterialCardRedirect() {
  const location = useLocation();
  const { user } = useAuth();
  const prefill = location.state as MaterialCardPrefill | null;
  const canView = !!user?.is_superuser || ITEM_VIEW_PERMISSIONS.some((p) => user?.permissions.includes(p));
  const [target, setTarget] = useState<number | null | "fallback">(null);
  useEffect(() => {
    if (!canView || !prefill?.material || !prefill.color) {
      setTarget("fallback");
      return;
    }
    lookupItem({ material: prefill.material, color: prefill.color, thickness: prefill.thickness })
      .then(setTarget)
      .catch(() => setTarget("fallback"));
  }, [canView, prefill?.material, prefill?.color, prefill?.thickness]);
  if (target === null) return <Spin style={{ display: "block", margin: 48 }} />;
  if (target === "fallback") return <MaterialCard />;
  return <Navigate to={`/item/${target}?tab=stock`} replace />;
}
