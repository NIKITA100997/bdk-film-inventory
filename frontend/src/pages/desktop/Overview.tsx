import { useMemo, useState } from "react";
import { Card, Col, Row, Statistic, Typography, Space, Button, Input } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import { listPurchaseRequests } from "../../api/purchasing";
import { listOrders, getOrdersReport } from "../../api/orders";
import { listSessions } from "../../api/inventory";
import { getDonorAccuracy, getStaleUnits } from "../../api/reports";
import { listMaterialSkus } from "../../api/dictionaries";
import { searchUnits } from "../../api/units";
import { runUnitOrMaterialSearch } from "../../utils/unitSearch";

const areaLabels: Record<string, string> = {
  okutka_tsargovykh: "Окутка царговых",
  shchitovye_dveri: "Щитовые двери",
  tselnolistovye_dveri: "Цельнолистовые двери",
};

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
  const hasReceive = has("units.receive");
  const hasIssue = has("units.issue");
  const hasCut = has("units.cut");
  const hasReturn = has("units.return");
  // "В работе у участков" полезен всем, кто хоть как-то соприкасается со
  // складскими операциями или уже видит планирование/инвентаризацию — не
  // привязано к одной роли, чтобы не плодить очередной хардкод по имени роли.
  const showIssuedWork = hasReceive || hasIssue || hasCut || hasReturn || showInventory || showPlanning;
  const [quickQuery, setQuickQuery] = useState("");

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
  // Начальнику участка (есть свой user.area) — только его участок; остальным
  // ролям без привязки к конкретному участку — сразу все три, разбивкой.
  const issuedUnitsQuery = useQuery({
    queryKey: ["units-issued", "overview", user?.area],
    queryFn: () => searchUnits({ status: "Выдан_участку", area: user?.area ?? undefined }),
    enabled: showIssuedWork,
  });

  const shortageCount = (ordersReportQuery.data ?? [])
    .filter((o) => o.status !== "closed")
    .reduce((sum, o) => sum + o.shortage_line_count, 0);
  // Потребность к выдаче (не путать с дефицитом остатка) — сколько ещё не
  // выдано/списано по открытым заказам сверх уже отгруженного факта
  // (actual_area_m2 считается по событиям Выдача_участку/Списание с этим
  // order_id, см. services/plan_fact.py) — даже если на складе всё есть,
  // это ещё физически не довезли до участка.
  const issuanceNeededM2 = (ordersReportQuery.data ?? [])
    .filter((o) => o.status !== "closed")
    .reduce((sum, o) => sum + Math.max(0, o.planned_area_m2 - o.actual_area_m2), 0);
  const openOrdersCount = (ordersQuery.data ?? []).filter((o) => o.status !== "closed").length;
  const openSessionsCount = (sessionsQuery.data ?? []).filter((s) => s.status === "in_progress").length;
  const issuedByArea = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const u of issuedUnitsQuery.data ?? []) {
      const key = u.area ?? "—";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [issuedUnitsQuery.data]);

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
        {showPlanning && (
          <Col span={6}>
            <Card loading={ordersReportQuery.isLoading} {...clickableProps("/orders")}>
              <Statistic
                title="Потребность к выдаче по заказам, м²"
                value={Math.round(issuanceNeededM2 * 10) / 10}
                valueStyle={{ color: issuanceNeededM2 > 0 ? "#C97A2B" : undefined }}
              />
            </Card>
          </Col>
        )}
        {showIssuedWork && user?.area && (
          <Col span={6}>
            <Card loading={issuedUnitsQuery.isLoading} {...clickableProps("/stock")}>
              <Statistic title="Выдано на участок — в работе" value={(issuedUnitsQuery.data ?? []).length} suffix="ед." />
            </Card>
          </Col>
        )}
        {showIssuedWork &&
          !user?.area &&
          Object.entries(areaLabels).map(([key, label]) => (
            <Col span={6} key={key}>
              <Card loading={issuedUnitsQuery.isLoading} {...clickableProps("/stock")}>
                <Statistic title={`В работе: ${label}`} value={issuedByArea[key] ?? 0} suffix="ед." />
              </Card>
            </Col>
          ))}
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

      {/* Быстрые действия — не привязаны к тому, есть ли другие сигналы: это
      основные действия оператора склада (приёмка/выдача), нужны ему
      независимо от того, что ещё показано выше. */}
      {(hasReceive || hasIssue) && (
        <Card>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Space wrap>
              {hasReceive && (
                <Button type="primary" onClick={() => navigate("/m/receive")}>
                  Начать приёмку
                </Button>
              )}
              {hasIssue && (
                <Button type="primary" onClick={() => navigate("/m/issue")}>
                  Выдача участку
                </Button>
              )}
            </Space>
            <Input.Search
              placeholder="ID единицы или материал…"
              enterButton="Найти"
              style={{ maxWidth: 360 }}
              value={quickQuery}
              onChange={(e) => setQuickQuery(e.target.value)}
              onSearch={(v) => runUnitOrMaterialSearch(v, navigate)}
            />
          </Space>
        </Card>
      )}

      {!showPlanning &&
        !showPurchasing &&
        !showOrders &&
        !showInventory &&
        !showDonorAccuracy &&
        !showStale &&
        !showSales &&
        !showIssuedWork &&
        !hasReceive &&
        !hasIssue && (
          <Card>
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Typography.Text type="secondary">Для вашей роли пока нет отдельных сигналов на обзорном экране.</Typography.Text>
              <Input.Search
                placeholder="ID единицы или материал…"
                enterButton="Найти"
                style={{ maxWidth: 360 }}
                value={quickQuery}
                onChange={(e) => setQuickQuery(e.target.value)}
                onSearch={(v) => runUnitOrMaterialSearch(v, navigate)}
              />
            </Space>
          </Card>
        )}
    </Space>
  );
}
