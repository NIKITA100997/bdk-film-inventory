import { Card, Col, Row, Statistic, Typography, Space } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import { listPurchaseRequests } from "../../api/purchasing";
import { listOrders, getOrdersReport } from "../../api/orders";
import { listSessions } from "../../api/inventory";
import { getDonorAccuracy, getStaleUnits } from "../../api/reports";
import { listMaterialSkus } from "../../api/dictionaries";

/** Обзор (5.5 ТЗ) — сводка сигналов по роли: у каждой роли своя выборка
 * карточек, собранная из уже существующих отчётов/списков (без нового
 * бэкенда) — нехватка, буферы заказов, закупки, точность донор-рекомендаций.
 * Карточки кликабельны — ведут в раздел-источник (10 раздел бэклога
 * доработок). Настраиваемого набора виджетов пока нет — состав фиксирован
 * по роли, как и раньше. */
export default function Overview() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const has = (permission: string) => !!user?.is_superuser || !!user?.permissions.includes(permission);

  const showPlanning = has("reports.view");
  const showPurchasing = has("purchasing.manage");
  const showOrders = has("orders.close");
  const showInventory = has("inventory.manage");
  const showDonorAccuracy = has("reports.view");
  const showStale = has("inventory.manage");
  const showSales = has("sales_calculator.view");

  const ordersReportQuery = useQuery({ queryKey: ["orders-report", "overview"], queryFn: getOrdersReport, enabled: showPlanning });
  const purchasingQuery = useQuery({
    queryKey: ["purchase-requests", "open"],
    queryFn: () => listPurchaseRequests("open"),
    enabled: showPurchasing,
  });
  const ordersQuery = useQuery({ queryKey: ["orders"], queryFn: listOrders, enabled: showOrders });
  const sessionsQuery = useQuery({ queryKey: ["inventory-sessions"], queryFn: listSessions, enabled: showInventory });
  const donorQuery = useQuery({
    queryKey: ["donor-accuracy", "overview"],
    queryFn: () => getDonorAccuracy(dayjs().subtract(30, "day").format("YYYY-MM-DD"), dayjs().format("YYYY-MM-DD")),
    enabled: showDonorAccuracy,
  });
  const staleQuery = useQuery({ queryKey: ["stale-units", "overview"], queryFn: () => getStaleUnits(), enabled: showStale });
  const skusQuery = useQuery({ queryKey: ["material-skus", "overview"], queryFn: listMaterialSkus, enabled: showSales });

  const shortageCount = (ordersReportQuery.data ?? [])
    .filter((o) => o.status !== "closed")
    .reduce((sum, o) => sum + o.shortage_line_count, 0);
  const openOrdersCount = (ordersQuery.data ?? []).filter((o) => o.status !== "closed").length;
  const openSessionsCount = (sessionsQuery.data ?? []).filter((s) => s.status === "in_progress").length;

  const clickableProps = (path: string) => ({
    hoverable: true,
    onClick: () => navigate(path),
    style: { cursor: "pointer" },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={4}>Обзор</Typography.Title>

      <Row gutter={[16, 16]}>
        {showPlanning && (
          <Col span={6}>
            <Card loading={ordersReportQuery.isLoading} {...clickableProps("/orders")}>
              <Statistic title="Дефицитных позиций по заказам" value={shortageCount} valueStyle={{ color: shortageCount > 0 ? "#C97A2B" : undefined }} />
            </Card>
          </Col>
        )}
        {showPurchasing && (
          <Col span={6}>
            <Card loading={purchasingQuery.isLoading} {...clickableProps("/purchasing")}>
              <Statistic title="Открытых заявок поставщику" value={(purchasingQuery.data ?? []).length} />
            </Card>
          </Col>
        )}
        {showOrders && (
          <Col span={6}>
            <Card loading={ordersQuery.isLoading} {...clickableProps("/orders")}>
              <Statistic title="Открытых заказов" value={openOrdersCount} />
            </Card>
          </Col>
        )}
        {showInventory && (
          <Col span={6}>
            <Card loading={sessionsQuery.isLoading} {...clickableProps("/inventory")}>
              <Statistic title="Сессий инвентаризации в процессе" value={openSessionsCount} />
            </Card>
          </Col>
        )}
        {showDonorAccuracy && donorQuery.data && (
          <Col span={6}>
            <Card loading={donorQuery.isLoading} {...clickableProps("/reports")}>
              <Statistic title="Точность донор-рекомендаций, 30 дней" value={donorQuery.data.accuracy_percent} suffix="%" />
            </Card>
          </Col>
        )}
        {showStale && (
          <Col span={6}>
            <Card loading={staleQuery.isLoading} {...clickableProps("/reports")}>
              <Statistic
                title="Остатков давно не двигалось"
                value={(staleQuery.data ?? []).length}
                valueStyle={{ color: (staleQuery.data ?? []).length > 0 ? "#C97A2B" : undefined }}
              />
            </Card>
          </Col>
        )}
        {showSales && (
          <Col span={6}>
            <Card loading={skusQuery.isLoading} {...clickableProps("/sales-calculator")}>
              <Statistic title="Позиций в номенклатуре — открыть калькулятор" value={(skusQuery.data ?? []).length} />
            </Card>
          </Col>
        )}
      </Row>

      {!showPlanning && !showPurchasing && !showOrders && !showInventory && !showDonorAccuracy && !showStale && !showSales && (
        <Typography.Paragraph type="secondary">
          Для вашей роли пока нет отдельных сигналов на обзорном экране.
        </Typography.Paragraph>
      )}
    </Space>
  );
}
