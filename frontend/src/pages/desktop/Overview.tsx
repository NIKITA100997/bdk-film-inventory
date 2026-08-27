import { useEffect, useMemo, useState } from "react";
import { Card, Col, Row, Typography, Space, Button, Input } from "antd";
import Statistic from "../../components/Statistic";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import { getStockOverview, listPurchaseRequests } from "../../api/purchasing";
import { listSessions } from "../../api/inventory";
import { getDonorAccuracy, getStaleUnits, getDefectsOverview, getRollsVsStrips, getStockSummary, getCuttingDiscrepancies } from "../../api/reports";
import { listMaterialSkus } from "../../api/dictionaries";
import { getBlanksDemand } from "../../api/production";
import { searchUnits } from "../../api/units";
import { listAreas } from "../../api/areas";
import { runUnitOrMaterialSearch } from "../../utils/unitSearch";
import { isOnboardingSeen } from "../../utils/onboarding";
import OnboardingCard from "../../components/OnboardingCard";
import { UnplacedUnitsCard } from "./StorageMap";
import { useColumnSettings, ColumnSettingsButton, type ColumnOption } from "../../components/ColumnSettings";

// Раздел про настраиваемый обзор — тот же приём, что уже настройка
// столбцов у таблиц (useColumnSettings полностью общий, ничего
// специфичного для колонок в нём нет), тот же значок-шестерёнка вместо
// нового UI-паттерна. Порядок — как карточки идут в разметке ниже.
const TILE_OPTIONS: ColumnOption[] = [
  { key: "issued-work", label: "В работе у участков" },
  { key: "purchase-requests", label: "Открытых заявок поставщику" },
  { key: "reorder", label: "Пора заказывать (по расходу)" },
  { key: "inventory-sessions", label: "Сессий инвентаризации в процессе" },
  { key: "donor-accuracy", label: "Точность донор-рекомендаций" },
  { key: "defects", label: "Реальный брак/повреждения" },
  { key: "stale", label: "Остатков давно не двигалось" },
  { key: "blanks", label: "Заготовок не хватает по ширинам" },
  { key: "skus", label: "Позиций в номенклатуре" },
  { key: "rolls-strips", label: "Рулоны и штрипсы" },
  { key: "total-stock", label: "Общий остаток, м²" },
  { key: "cutting-discrepancies", label: "Отклонения при резке" },
  { key: "unplaced", label: "Без места" },
];

/** Обзор (5.5 ТЗ) — сводка сигналов по роли: у каждой роли своя выборка
 * карточек, собранная из уже существующих отчётов/списков (без нового
 * бэкенда) — нехватка, буферы заказов, закупки, точность донор-рекомендаций.
 * Карточки кликабельны — ведут в раздел-источник (10 раздел бэклога
 * доработок). Настраиваемого набора виджетов пока нет — состав фиксирован
 * по роли, как и раньше. */
export default function Overview() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const has = (permission: string) => !!user?.is_superuser || !!user?.permissions.includes(permission);
  const tileSettings = useColumnSettings("dashboard-overview", TILE_OPTIONS, []);

  // Раздел 16 бэклога доработок — онбординг нового сотрудника. Авто-показ
  // при первом входе (не видел ни разу — localStorage по userId) либо по
  // явному флагу из навигации (повторное открытие через меню пользователя,
  // AppLayout.tsx — тот же паттерн navigate(path,{state}), что и
  // runUnitOrMaterialSearch/UnitCard.tsx).
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (!user) return;
    const forced = (location.state as { showOnboarding?: boolean } | null)?.showOnboarding;
    if (forced || !isOnboardingSeen(user.id)) setShowOnboarding(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, user?.id]);

  const showPurchasing = has("purchasing.manage");
  const showInventory = has("inventory.manage");
  const showDonorAccuracy = has("reports.view");
  const showStale = has("inventory.manage");
  const showDefects = has("reports.view");
  const showBlanks = has("units.issue");
  const showSales = has("sales_calculator.view");
  const hasReceive = has("units.receive");
  const hasIssue = has("units.issue");
  const hasCut = has("units.cut");
  const hasReturn = has("units.return");
  const hasPlace = has("units.place");
  // "В работе у участков" полезен всем, кто хоть как-то соприкасается со
  // складскими операциями или уже видит планирование/инвентаризацию — не
  // привязано к одной роли, чтобы не плодить очередной хардкод по имени роли.
  const showIssuedWork = hasReceive || hasIssue || hasCut || hasReturn || showInventory || showDonorAccuracy;
  const [quickQuery, setQuickQuery] = useState("");
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas, enabled: showIssuedWork && !user?.area });

  const purchasingQuery = useQuery({
    queryKey: ["purchase-requests", "open"],
    queryFn: () => listPurchaseRequests("open"),
    enabled: showPurchasing,
  });
  // Раздел про точку дозаказа по расходу — тот же showPurchasing, что и
  // "Открытых заявок поставщику" (getStockOverview требует то же право
  // purchasing.manage).
  const reorderQuery = useQuery({
    queryKey: ["stock-overview", "overview"],
    queryFn: getStockOverview,
    enabled: showPurchasing,
  });
  const reorderCount = (reorderQuery.data ?? []).filter((r) => r.reorder_suggested).length;
  const sessionsQuery = useQuery({ queryKey: ["inventory-sessions"], queryFn: listSessions, enabled: showInventory });
  const donorQuery = useQuery({
    queryKey: ["donor-accuracy", "overview"],
    queryFn: () => getDonorAccuracy(dayjs().subtract(30, "day").format("YYYY-MM-DD"), dayjs().format("YYYY-MM-DD")),
    enabled: showDonorAccuracy,
  });
  const staleQuery = useQuery({ queryKey: ["stale-units", "overview"], queryFn: () => getStaleUnits(), enabled: showStale });
  // Раздел 16 бэклога доработок — «брак/списания» был одним из сигналов,
  // разбросанных по разным местам без представления на «Обзоре» вовсе
  // (в отличие от донор-рекомендаций, у которых карточка уже была).
  const defectsQuery = useQuery({
    queryKey: ["defects-overview", "overview"],
    queryFn: () => getDefectsOverview(dayjs().subtract(30, "day").format("YYYY-MM-DD"), dayjs().format("YYYY-MM-DD")),
    enabled: showDefects,
  });
  // Раздел 16 бэклога доработок — "Заготовки" не всплывали нигде, кроме
  // своего пункта меню (та же ошибка, что раньше была с донор-рекомендациями,
  // 2.2), источник потребности виден только тому, кто зашёл специально.
  const blanksQuery = useQuery({ queryKey: ["blanks-demand", "overview"], queryFn: getBlanksDemand, enabled: showBlanks });
  const blanksDeficitCount = (blanksQuery.data ?? []).filter((r) => r.deficit_length_m > 0).length;
  const skusQuery = useQuery({ queryKey: ["material-skus", "overview"], queryFn: () => listMaterialSkus(), enabled: showSales });
  // Раздел про недостающие показатели на "Обзоре" — рулоны/штрипсы,
  // общий остаток и отклонения при резке уже считаются в отчётах, но
  // нигде не всплывали как сигнал на главном экране (та же проблема,
  // что раньше была у брака/заготовок).
  const rollsStripsQuery = useQuery({ queryKey: ["rolls-vs-strips", "overview"], queryFn: () => getRollsVsStrips(), enabled: showDonorAccuracy });
  const rollsCount = (rollsStripsQuery.data ?? []).reduce((sum, r) => sum + r.roll_count, 0);
  const stripsCount = (rollsStripsQuery.data ?? []).reduce((sum, r) => sum + r.strip_count, 0);
  const stockSummaryQuery = useQuery({ queryKey: ["stock-summary", "overview"], queryFn: () => getStockSummary(), enabled: showDonorAccuracy });
  const totalStockAreaM2 = (stockSummaryQuery.data ?? []).reduce((sum, r) => sum + r.total_area_m2, 0);
  const cuttingDiscrepancyQuery = useQuery({
    queryKey: ["cutting-discrepancies", "overview"],
    queryFn: () => getCuttingDiscrepancies(dayjs().subtract(30, "day").format("YYYY-MM-DD"), dayjs().format("YYYY-MM-DD")),
    enabled: showDonorAccuracy,
  });
  // Начальнику участка (есть свой user.area) — только его участок; остальным
  // ролям без привязки к конкретному участку — сразу все три, разбивкой.
  const issuedUnitsQuery = useQuery({
    queryKey: ["units-issued", "overview", user?.area],
    queryFn: () => searchUnits({ status: "Выдан_участку", area: user?.area ?? undefined }),
    enabled: showIssuedWork,
  });

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
      <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>Обзор</Typography.Title>
        <ColumnSettingsButton columns={TILE_OPTIONS} settings={tileSettings} itemLabel="карточек" panelTitle="Карточки обзора" />
      </Space>

      {showOnboarding && <OnboardingCard onClose={() => setShowOnboarding(false)} />}

      {/* Раздел про единый рабочий экран — тот же список "без места", что
          уже есть на "Стеллажах и полках" (UnplacedUnitsCard оттуда же,
          просто переиспользован), но прямо на "Обзоре" — куда оператор и
          так попадает по входу, без отдельного похода в "Стеллажи". */}
      {hasPlace && tileSettings.isVisible("unplaced") && <UnplacedUnitsCard />}

      <Row gutter={[16, 16]}>
        {showIssuedWork && user?.area && tileSettings.isVisible("issued-work") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={issuedUnitsQuery.isLoading} {...clickableProps("/stock")}>
              <Statistic title="Выдано на участок — в работе" value={(issuedUnitsQuery.data ?? []).length} suffix="ед." />
            </Card>
          </Col>
        )}
        {showIssuedWork &&
          !user?.area &&
          tileSettings.isVisible("issued-work") &&
          (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => (
            <Col xs={12} sm={12} md={8} lg={6} key={a.code}>
              <Card loading={issuedUnitsQuery.isLoading} {...clickableProps("/stock")}>
                <Statistic title={`В работе: ${a.name}`} value={issuedByArea[a.code] ?? 0} suffix="ед." />
              </Card>
            </Col>
          ))}
        {showPurchasing && tileSettings.isVisible("purchase-requests") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={purchasingQuery.isLoading} {...clickableProps("/purchasing")}>
              <Statistic title="Открытых заявок поставщику" value={(purchasingQuery.data ?? []).length} />
            </Card>
          </Col>
        )}
        {showPurchasing && tileSettings.isVisible("reorder") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={reorderQuery.isLoading} {...clickableProps("/purchasing")}>
              <Statistic
                title="Пора заказывать (по расходу)"
                value={reorderCount}
                valueStyle={{ color: reorderCount > 0 ? "#C97A2B" : undefined }}
              />
            </Card>
          </Col>
        )}
        {showInventory && tileSettings.isVisible("inventory-sessions") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={sessionsQuery.isLoading} {...clickableProps("/inventory")}>
              <Statistic title="Сессий инвентаризации в процессе" value={openSessionsCount} />
            </Card>
          </Col>
        )}
        {showDonorAccuracy && donorQuery.data && tileSettings.isVisible("donor-accuracy") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={donorQuery.isLoading} {...clickableProps("/reports")}>
              <Statistic title="Точность донор-рекомендаций, 30 дней" value={donorQuery.data.accuracy_percent} suffix="%" />
            </Card>
          </Col>
        )}
        {showDefects && defectsQuery.data && tileSettings.isVisible("defects") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={defectsQuery.isLoading} {...clickableProps("/defects")}>
              <Statistic
                title="Реальный брак/повреждения, 30 дней"
                value={defectsQuery.data.warehouse_real_defect_m}
                suffix="м"
                precision={1}
                valueStyle={{ color: (defectsQuery.data.warehouse_real_defect_m_delta_percent ?? 0) > 0 ? "#C97A2B" : undefined }}
              />
            </Card>
          </Col>
        )}
        {showStale && tileSettings.isVisible("stale") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={staleQuery.isLoading} {...clickableProps("/reports")}>
              <Statistic
                title="Остатков давно не двигалось"
                value={(staleQuery.data ?? []).length}
                valueStyle={{ color: (staleQuery.data ?? []).length > 0 ? "#C97A2B" : undefined }}
              />
            </Card>
          </Col>
        )}
        {showDonorAccuracy && tileSettings.isVisible("rolls-strips") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={rollsStripsQuery.isLoading} {...clickableProps("/reports")}>
              <Row gutter={8}>
                <Col span={12}>
                  <Statistic title="Рулонов" value={rollsCount} />
                </Col>
                <Col span={12}>
                  <Statistic title="Штрипсов" value={stripsCount} />
                </Col>
              </Row>
            </Card>
          </Col>
        )}
        {showDonorAccuracy && tileSettings.isVisible("total-stock") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={stockSummaryQuery.isLoading} {...clickableProps("/reports")}>
              <Statistic title="Общий остаток" value={totalStockAreaM2} suffix="м²" precision={1} />
            </Card>
          </Col>
        )}
        {showDonorAccuracy && tileSettings.isVisible("cutting-discrepancies") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={cuttingDiscrepancyQuery.isLoading} {...clickableProps("/reports")}>
              <Statistic
                title="Отклонений при резке, 30 дней"
                value={(cuttingDiscrepancyQuery.data ?? []).length}
                valueStyle={{ color: (cuttingDiscrepancyQuery.data ?? []).length > 0 ? "#C97A2B" : undefined }}
              />
            </Card>
          </Col>
        )}
        {showBlanks && tileSettings.isVisible("blanks") && (
          <Col xs={12} sm={12} md={8} lg={6}>
            <Card loading={blanksQuery.isLoading} {...clickableProps("/blanks")}>
              <Statistic
                title="Заготовок не хватает по ширинам"
                value={blanksDeficitCount}
                valueStyle={{ color: blanksDeficitCount > 0 ? "#C97A2B" : undefined }}
              />
            </Card>
          </Col>
        )}
        {showSales && tileSettings.isVisible("skus") && (
          <Col xs={12} sm={12} md={8} lg={6}>
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

      {!showPurchasing &&
        !showInventory &&
        !showDonorAccuracy &&
        !showStale &&
        !showDefects &&
        !showBlanks &&
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
