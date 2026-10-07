import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Card, Col, Input, Row, Space, Typography } from "antd";
import { CheckCircleTwoTone, RightOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import Statistic from "../../components/Statistic";
import { useAuth } from "../../auth/AuthContext";
import { getStockOverview, listPurchaseRequests } from "../../api/purchasing";
import { listSessions } from "../../api/inventory";
import { getCuttingDiscrepancies, getDefectsOverview, getDonorAccuracy, getRollsVsStrips, getStaleUnits, getStockSummary } from "../../api/reports";
import { getBlanksDemand, listProductionTasks } from "../../api/production";
import { getOrdersReadiness, listProductionOrders } from "../../api/productionOrders";
import { listPfDemand } from "../../api/pfDemand";
import { searchUnits } from "../../api/units";
import { listFgStock } from "../../api/finishedGoods";
import { listSites } from "../../api/sites";
import { actionRequestsSummary, getPeriod } from "../../api/control";
import { getProductivity } from "../../api/productivity";
import { runUnitOrMaterialSearch } from "../../utils/unitSearch";
import { isOnboardingSeen } from "../../utils/onboarding";
import OnboardingCard from "../../components/OnboardingCard";
import { UnplacedUnitsCard } from "./StorageMap";
import { useColumnSettings, ColumnSettingsButton, type ColumnOption } from "../../components/ColumnSettings";

// Блоки «Обзора» (07.10): шестерёнка включает и выключает их, как столбцы таблиц.
const BLOCKS: ColumnOption[] = [
  { key: "attention", label: "Требует внимания" },
  { key: "production", label: "Производство" },
  { key: "film", label: "Склад плёнки" },
  { key: "pf", label: "П/ф на участках" },
  { key: "fg", label: "Готовая продукция" },
  { key: "purchasing", label: "Закупки" },
  { key: "unplaced", label: "Список рулонов без места" },
  { key: "film-reports", label: "Отчётные показатели плёнки (донор-рекомендации, резка, брак)" },
];
const HIDDEN_BY_DEFAULT = ["unplaced", "film-reports"];

const fmt = (v: number, digits = 0) => (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString("ru-RU");

type Signal = { key: string; label: string; value: number | string; path: string; level: "critical" | "warning" | "info" };
const LEVEL_COLOR = { critical: "#cf1322", warning: "#C97A2B", info: "#4b6584" };

/** Обзор (переделан 07.10): сверху — только то, что требует внимания
 * (ненулевые сигналы по срочности, каждый ведёт в свой раздел), ниже —
 * компактные блоки по направлениям. Состав — по правам роли; мастер с
 * участком сюда не попадает (Home → «Мой участок»). */
export default function Overview() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const has = (p: string) => !!user?.is_superuser || !!user?.permissions.includes(p);
  const blocks = useColumnSettings("dashboard-overview-v2", BLOCKS, HIDDEN_BY_DEFAULT);
  const show = (k: string) => blocks.isVisible(k);

  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (!user) return;
    const forced = (location.state as { showOnboarding?: boolean } | null)?.showOnboarding;
    if (forced || !isOnboardingSeen(user.id)) setShowOnboarding(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, user?.id]);

  const canReports = has("reports.view");
  const canShop = has("production_tasks.manage") || has("production_tasks.view");
  const canSales = has("sales_calculator.view");
  const canLate = canShop || has("production_tasks.report") || canSales;
  const canPf = has("production_tasks.manage") || has("part_units.manage");
  const canPurch = has("purchasing.manage");
  const canInv = has("inventory.manage");
  const hasReceive = has("units.receive");
  const hasIssue = has("units.issue");
  const hasPlace = has("units.place");
  const canFilm = canReports || hasIssue || hasReceive;
  const canFg = has("fg.ship") || canReports || canSales;
  const canPeriod = has("period.manage");
  const myArea = user?.area ?? null;

  const today = dayjs().format("YYYY-MM-DD");
  const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
  const month30 = dayjs().subtract(30, "day").format("YYYY-MM-DD");

  // --- данные (каждый запрос — только тем, кому он виден)
  const reqQ = useQuery({ queryKey: ["action-requests-summary"], queryFn: actionRequestsSummary });
  const periodQ = useQuery({ queryKey: ["period-closing"], queryFn: getPeriod, enabled: canPeriod });
  const ordersQ = useQuery({ queryKey: ["production-orders", "overview"], queryFn: () => listProductionOrders(false), enabled: canShop });
  const readinessQ = useQuery({ queryKey: ["order-readiness", "overview"], queryFn: () => getOrdersReadiness(false), enabled: canLate });
  const pfQ = useQuery({ queryKey: ["pf-demand", "overview"], queryFn: () => listPfDemand(), enabled: canPf });
  const tasksQ = useQuery({ queryKey: ["production-tasks", "overview"], queryFn: listProductionTasks, enabled: canShop || !!myArea });
  const prodQ = useQuery({
    queryKey: ["productivity", "overview", yesterday, today],
    queryFn: () => getProductivity({ date_from: yesterday, date_to: today }),
    enabled: canShop || canReports,
  });
  const purchQ = useQuery({ queryKey: ["purchase-requests", "open"], queryFn: () => listPurchaseRequests("open"), enabled: canPurch });
  const reorderQ = useQuery({ queryKey: ["stock-overview", "overview"], queryFn: getStockOverview, enabled: canPurch });
  const sessionsQ = useQuery({ queryKey: ["inventory-sessions"], queryFn: listSessions, enabled: canInv });
  const staleQ = useQuery({ queryKey: ["stale-units", "overview"], queryFn: () => getStaleUnits(), enabled: canReports });
  const blanksQ = useQuery({ queryKey: ["blanks-demand", "overview"], queryFn: getBlanksDemand, enabled: hasIssue });
  const unplacedQ = useQuery({ queryKey: ["units-unplaced"], queryFn: () => searchUnits({ unplaced: true }), enabled: hasPlace });
  const rollsQ = useQuery({ queryKey: ["rolls-vs-strips", "overview"], queryFn: () => getRollsVsStrips(), enabled: canFilm });
  const stockSumQ = useQuery({ queryKey: ["stock-summary", "overview"], queryFn: () => getStockSummary(), enabled: canFilm });
  const issuedQ = useQuery({
    queryKey: ["units-issued", "overview", myArea],
    queryFn: () => searchUnits({ status: "Выдан_участку", area: myArea ?? undefined }),
    enabled: canFilm,
  });
  const fgQ = useQuery({ queryKey: ["fg-stock"], queryFn: listFgStock, enabled: canFg });
  const sitesQ = useQuery({ queryKey: ["sites"], queryFn: listSites, enabled: canFg });
  const extra = show("film-reports") && canReports;
  const donorQ = useQuery({ queryKey: ["donor-accuracy", "overview"], queryFn: () => getDonorAccuracy(month30, today), enabled: extra });
  const defectsQ = useQuery({ queryKey: ["defects-overview", "overview"], queryFn: () => getDefectsOverview(month30, today), enabled: extra });
  const cutQ = useQuery({ queryKey: ["cutting-discrepancies", "overview"], queryFn: () => getCuttingDiscrepancies(month30, today), enabled: extra });

  // --- цифры
  const draft = (ordersQ.data ?? []).filter((o) => o.status === "draft").length;
  const released = (ordersQ.data ?? []).filter((o) => o.status === "released").length;
  const late = (readinessQ.data ?? []).filter((o) => o.plan_late || o.plan_overdue > 0).length;
  const pfShort = (pfQ.data ?? []).filter((r) => r.shortage > 0).length;
  const pfStock = (pfQ.data ?? []).reduce((s, r) => s + (r.stock || 0), 0);
  const pfInWork = (pfQ.data ?? []).reduce((s, r) => s + (r.in_work || 0), 0);
  const openTasks = (tasksQ.data ?? []).filter((t) => t.is_active && (!myArea || canShop || t.area === myArea)).length;
  const myTasks = myArea ? (tasksQ.data ?? []).filter((t) => t.is_active && t.area === myArea).length : 0;
  const goodOn = (day: string) => (prodQ.data?.output ?? []).filter((o) => o.day === day).reduce((s, o) => s + o.good, 0);
  const issuedTodayM = (prodQ.data?.issues ?? []).filter((i) => i.day === today).reduce((s, i) => s + i.length_m, 0);
  const reorder = (reorderQ.data ?? []).filter((r) => r.reorder_suggested).length;
  const blanksDeficit = (blanksQ.data ?? []).filter((r) => r.deficit_length_m > 0).length;
  const rolls = (rollsQ.data ?? []).reduce((s, r) => s + r.roll_count, 0);
  const strips = (rollsQ.data ?? []).reduce((s, r) => s + r.strip_count, 0);
  const stockM2 = (stockSumQ.data ?? []).reduce((s, r) => s + r.total_area_m2, 0);
  const openSessions = (sessionsQ.data ?? []).filter((s) => s.status === "in_progress").length;
  const mainSite = (sitesQ.data ?? []).find((s) => s.is_fg_main && s.is_active);
  const fgTotal = (fgQ.data ?? []).reduce((s, r) => s + r.qty, 0);
  const fgToMove = mainSite ? (fgQ.data ?? []).filter((r) => r.site_id !== mainSite.id).reduce((s, r) => s + r.qty, 0) : 0;
  const fgToShip = (fgQ.data ?? []).filter((r) => r.invoice_no).reduce((s, r) => s + r.qty, 0);
  const lastMonthEnd = dayjs().startOf("month").subtract(1, "day");
  const closedUntil = periodQ.data?.closed_until ? dayjs(periodQ.data.closed_until) : null;
  const periodOpen = canPeriod && periodQ.data && (!closedUntil || closedUntil.isBefore(lastMonthEnd, "day"));

  const signals: Signal[] = useMemo(() => {
    const s: Signal[] = [];
    const add = (cond: boolean, sig: Signal) => cond && s.push(sig);
    add((reqQ.data?.to_approve ?? 0) > 0, { key: "req", label: "Запросов сотрудников ждут решения", value: reqQ.data?.to_approve ?? 0, path: "/action-requests?tab=pending", level: "critical" });
    add((reqQ.data?.mine_resolved ?? 0) > 0, { key: "mine", label: "По вашим запросам есть решение", value: reqQ.data?.mine_resolved ?? 0, path: "/action-requests?tab=mine", level: "info" });
    add(late > 0, { key: "late", label: "Заказов не успевают к отгрузке", value: late, path: "/order-readiness", level: "critical" });
    add(pfShort > 0, { key: "pf", label: "Деталей п/ф не хватает", value: pfShort, path: "/demand?tab=pf", level: "warning" });
    add(draft > 0, { key: "draft", label: "Черновиков заказов ждут запуска", value: draft, path: "/production-orders", level: "warning" });
    add(reorder > 0, { key: "reorder", label: "Пора заказывать плёнку", value: reorder, path: "/purchasing?tab=reorder", level: "warning" });
    add(blanksDeficit > 0, { key: "blanks", label: "Плёнки не хватает по ширинам", value: blanksDeficit, path: "/blanks", level: "warning" });
    add(fgToMove > 0, { key: "fgmove", label: `Готовых дверей ждут перевозки на ${mainSite?.name ?? "основной склад"}`, value: fgToMove, path: "/stock?kind=fg", level: "warning" });
    add((unplacedQ.data?.length ?? 0) > 0, { key: "unplaced", label: "Рулонов без места на стеллаже", value: unplacedQ.data?.length ?? 0, path: "/stock?kind=film&tab=map", level: "warning" });
    add(!!periodOpen, { key: "period", label: `Не закрыт ${lastMonthEnd.format("MMMM YYYY")} — закрыть период`, value: "", path: "/period-closing", level: "info" });
    add((staleQ.data?.length ?? 0) > 0, { key: "stale", label: "Остатков давно не двигалось", value: staleQ.data?.length ?? 0, path: "/reports", level: "info" });
    add(openSessions > 0, { key: "inv", label: "Инвентаризаций в процессе", value: openSessions, path: "/inventory", level: "info" });
    return s;
  }, [reqQ.data, late, pfShort, draft, reorder, blanksDeficit, fgToMove, mainSite, unplacedQ.data, periodOpen, lastMonthEnd, staleQ.data, openSessions]);

  const anyLoading = [reqQ, ordersQ, readinessQ, pfQ, reorderQ, blanksQ, unplacedQ, staleQ].some((q) => q.isLoading && q.fetchStatus !== "idle");

  const section = (key: string, title: string, path: string, items: ReactNode[], loading?: boolean) => (
    <Col xs={24} md={12} xl={8} key={key}>
      <Card
        size="small"
        title={title}
        loading={loading}
        extra={
          <Button type="link" size="small" onClick={() => navigate(path)}>
            открыть <RightOutlined />
          </Button>
        }
        style={{ height: "100%" }}
      >
        <Row gutter={[12, 12]}>
          {items.map((it, i) => (
            <Col span={12} key={i}>
              {it}
            </Col>
          ))}
        </Row>
      </Card>
    </Col>
  );

  const sections: ReactNode[] = [];
  if (show("production") && (canShop || myArea)) {
    sections.push(
      section("production", "Производство", "/productivity", [
        ...(canShop ? [<Statistic key="r" title="Заказов в работе" value={released} />] : []),
        <Statistic key="t" title={canShop ? "Открытых заданий" : "Заданий моего участка"} value={canShop ? openTasks : myTasks} />,
        ...(prodQ.data
          ? [
              <Statistic key="y" title="Выпуск вчера, шт" value={fmt(goodOn(yesterday))} />,
              <Statistic key="d" title="Выпуск сегодня, шт" value={fmt(goodOn(today))} />,
            ]
          : []),
      ], ordersQ.isLoading || tasksQ.isLoading),
    );
  }
  if (show("film") && canFilm) {
    sections.push(
      section("film", "Склад плёнки", "/stock?kind=film", [
        <Statistic key="r" title="Рулонов / штрипсов" value={`${fmt(rolls)} / ${fmt(strips)}`} />,
        <Statistic key="m" title="Остаток, м²" value={fmt(stockM2)} />,
        <Statistic key="w" title={myArea ? "Выдано моему участку" : "Выдано участкам, ед."} value={fmt(issuedQ.data?.length ?? 0)} />,
        ...(prodQ.data ? [<Statistic key="t" title="Выдано сегодня, м" value={fmt(issuedTodayM, 1)} />] : []),
      ], rollsQ.isLoading || stockSumQ.isLoading),
    );
  }
  if (show("pf") && canPf) {
    sections.push(
      section("pf", "П/ф на участках", "/demand?tab=pf", [
        <Statistic key="s" title="На остатке, шт" value={fmt(pfStock)} />,
        <Statistic key="w" title="Запущено в работу, шт" value={fmt(pfInWork)} />,
        <Statistic key="d" title="Позиций с нехваткой" value={pfShort} valueStyle={{ color: pfShort ? LEVEL_COLOR.warning : undefined }} />,
      ], pfQ.isLoading),
    );
  }
  if (show("fg") && canFg) {
    sections.push(
      section("fg", "Готовая продукция", "/stock?kind=fg", [
        <Statistic key="t" title="На складе, шт" value={fmt(fgTotal)} />,
        <Statistic key="s" title="Под счета — к отгрузке, шт" value={fmt(fgToShip)} />,
        ...(mainSite ? [<Statistic key="m" title={`Ждут перевозки на ${mainSite.name}`} value={fmt(fgToMove)} valueStyle={{ color: fgToMove ? LEVEL_COLOR.warning : undefined }} />] : []),
      ], fgQ.isLoading),
    );
  }
  if (show("purchasing") && canPurch) {
    sections.push(
      section("purchasing", "Закупки", "/purchasing", [
        <Statistic key="o" title="Открытых заявок поставщику" value={(purchQ.data ?? []).length} />,
        <Statistic key="r" title="Пора заказывать" value={reorder} valueStyle={{ color: reorder ? LEVEL_COLOR.warning : undefined }} />,
      ], purchQ.isLoading),
    );
  }
  if (extra) {
    sections.push(
      section("film-reports", "Плёнка: отчётные показатели, 30 дней", "/reports", [
        <Statistic key="d" title="Точность донор-рекомендаций" value={donorQ.data?.accuracy_percent ?? "—"} suffix={donorQ.data ? "%" : undefined} />,
        <Statistic key="c" title="Отклонений при резке" value={(cutQ.data ?? []).length} />,
        <Statistic key="b" title="Реальный брак, м" value={fmt(defectsQ.data?.warehouse_real_defect_m ?? 0, 1)} />,
      ]),
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
        <Space align="baseline" size={12}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Обзор
          </Typography.Title>
          <Typography.Text type="secondary">{dayjs().format("dddd, D MMMM")}</Typography.Text>
        </Space>
        <ColumnSettingsButton columns={BLOCKS} settings={blocks} itemLabel="блоков" panelTitle="Блоки обзора" />
      </Space>

      {showOnboarding && <OnboardingCard onClose={() => setShowOnboarding(false)} />}

      {show("attention") && (
        <Card size="small" title="Требует внимания" loading={anyLoading && signals.length === 0}>
          {signals.length === 0 ? (
            <Space>
              <CheckCircleTwoTone twoToneColor="#52c41a" />
              <Typography.Text>Всё в порядке — срочного нет</Typography.Text>
            </Space>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 8 }}>
              {signals.map((sg) => (
                <button
                  key={sg.key}
                  type="button"
                  onClick={() => navigate(sg.path)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    border: "1px solid #ececec",
                    borderLeft: `4px solid ${LEVEL_COLOR[sg.level]}`,
                    borderRadius: 6,
                    background: "#fff",
                    cursor: "pointer",
                    textAlign: "left",
                    font: "inherit",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 18, color: LEVEL_COLOR[sg.level], minWidth: 36, fontVariantNumeric: "tabular-nums" }}>
                    {typeof sg.value === "number" ? fmt(sg.value) : sg.value}
                  </span>
                  <span style={{ flex: 1 }}>{sg.label}</span>
                  <RightOutlined style={{ color: "#bbb", fontSize: 11 }} />
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {sections.length > 0 && <Row gutter={[16, 16]}>{sections}</Row>}

      {hasPlace && show("unplaced") && <UnplacedUnitsCard />}

      <Card size="small">
        <Space wrap size="middle">
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
          {(canShop || canReports) && <Button onClick={() => navigate("/productivity")}>Производительность участков</Button>}
          <SearchBox />
        </Space>
      </Card>
    </Space>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  return (
    <Input.Search
      placeholder="Номер (рулон, партия, задание, заказ) или материал…"
      enterButton="Найти"
      style={{ width: 380, maxWidth: "100%" }}
      value={q}
      onChange={(e) => setQ(e.target.value)}
      onSearch={(v) => runUnitOrMaterialSearch(v, navigate)}
    />
  );
}
