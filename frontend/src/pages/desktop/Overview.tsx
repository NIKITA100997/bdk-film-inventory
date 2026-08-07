import { Card, Col, Row, Statistic, Typography, Space } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import { listWeeklyPlans } from "../../api/plans";
import { listPurchaseRequests } from "../../api/purchasing";
import { listOrders } from "../../api/orders";
import { listSessions } from "../../api/inventory";
import { getDonorAccuracy } from "../../api/reports";

/** Обзор (5.5 ТЗ) — сводка сигналов по роли: у каждой роли своя выборка
 * карточек, собранная из уже существующих отчётов/списков (без нового
 * бэкенда) — нехватка, буферы заказов, закупки, точность донор-рекомендаций. */
export default function Overview() {
  const { user } = useAuth();
  const role = user?.role;

  const showPlanning = role === "nachalnik_tsekha" || role === "logist" || role === "admin";
  const showPurchasing = role === "snabzhenets" || role === "admin";
  const showOrders = role === "logist" || role === "kladovshchik" || role === "admin";
  const showInventory = role === "logist" || role === "kladovshchik" || role === "admin";
  const showDonorAccuracy = role === "logist" || role === "nachalnik_tsekha" || role === "admin";

  const plansQuery = useQuery({ queryKey: ["weekly-plans"], queryFn: listWeeklyPlans, enabled: showPlanning });
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

  const shortageCount = (plansQuery.data ?? [])[0]?.lines.filter((l) => l.shortage).length ?? 0;
  const openOrdersCount = (ordersQuery.data ?? []).filter((o) => o.status !== "closed").length;
  const openSessionsCount = (sessionsQuery.data ?? []).filter((s) => s.status === "in_progress").length;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={4}>Обзор</Typography.Title>

      <Row gutter={16}>
        {showPlanning && (
          <Col span={6}>
            <Card loading={plansQuery.isLoading}>
              <Statistic title="Сигналов нехватки в плане" value={shortageCount} valueStyle={{ color: shortageCount > 0 ? "#C97A2B" : undefined }} />
            </Card>
          </Col>
        )}
        {showPurchasing && (
          <Col span={6}>
            <Card loading={purchasingQuery.isLoading}>
              <Statistic title="Открытых заявок поставщику" value={(purchasingQuery.data ?? []).length} />
            </Card>
          </Col>
        )}
        {showOrders && (
          <Col span={6}>
            <Card loading={ordersQuery.isLoading}>
              <Statistic title="Открытых заказов" value={openOrdersCount} />
            </Card>
          </Col>
        )}
        {showInventory && (
          <Col span={6}>
            <Card loading={sessionsQuery.isLoading}>
              <Statistic title="Сессий инвентаризации в процессе" value={openSessionsCount} />
            </Card>
          </Col>
        )}
        {showDonorAccuracy && donorQuery.data && (
          <Col span={6}>
            <Card loading={donorQuery.isLoading}>
              <Statistic title="Точность донор-рекомендаций, 30 дней" value={donorQuery.data.accuracy_percent} suffix="%" />
            </Card>
          </Col>
        )}
      </Row>

      {!showPlanning && !showPurchasing && !showOrders && !showInventory && (
        <Typography.Paragraph type="secondary">
          Для вашей роли пока нет отдельных сигналов на обзорном экране.
        </Typography.Paragraph>
      )}
    </Space>
  );
}
