import { useEffect, useRef, useState, type ReactNode } from "react";
import { Layout, Menu, Grid, Typography, Button, Input, Avatar, Dropdown, Switch, Select, Badge, Tooltip, Space, Tag, Tour, notification } from "antd";
import type { TourProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import type { MenuProps } from "antd";
import { SearchOutlined, ArrowLeftOutlined, UserOutlined, LogoutOutlined, QuestionCircleOutlined, KeyOutlined, BellOutlined, ThunderboltFilled } from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { navTree, isNavItemVisible, isMasterUser, masterNav, type NavItem } from "./navConfig";
import { fontHeading } from "../theme";
import { getRecentSearches, runUnitOrMaterialSearch } from "../utils/unitSearch";
import {
  getSelectedPrinterIp,
  isVerticalPrint,
  NETWORK_PRINTERS,
  setSelectedPrinterIp,
  setVerticalPrint,
} from "../utils/printLabel";
import { getEffectiveUxMode, setStoredUxMode, type UxMode } from "../utils/uxMode";
import { useGlobalBarcodeScanner } from "../utils/useBarcodeScanner";
import { useRealtimeSync } from "../hooks/useRealtimeSync";
import QrScanButton from "../components/QrScanButton";
import OfflineBanner from "../components/OfflineBanner";
import { useInbox } from "../components/InboxList";
import { actionRequestsSummary } from "../api/control";
import ApprovalsDrawer from "../components/ApprovalsDrawer";
import ActionRequestPrompt from "../components/ActionRequestPrompt";
import PhoneTabBar from "./PhoneTabBar";
import WorkspaceTabs from "./WorkspaceTabs";
import ChangePasswordModal from "../components/ChangePasswordModal";

const { Header, Content } = Layout;

function playNotificationChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.setValueAtTime(880, now + 0.12);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch {
    /* браузер заблокировал автовоспроизведение звука — игнорируем */
  }
}

function HeaderNotificationsButton({
  onOpen,
  soundEnabled,
  btnRef,
}: {
  onOpen: (tab: "approvals" | "inbox" | "signals") => void;
  soundEnabled: boolean;
  btnRef?: React.RefObject<HTMLSpanElement | null>;
}) {
  const summaryQuery = useQuery({ queryKey: ["action-requests-summary"], queryFn: actionRequestsSummary, refetchInterval: 120_000 });
  const inboxQuery = useInbox();
  const toApprove = summaryQuery.data?.to_approve ?? 0;
  const inboxCount = (inboxQuery.data ?? []).length;
  const urgent = (inboxQuery.data ?? []).some((i) => i.level === "urgent");
  const totalCount = toApprove + inboxCount;
  const prevCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (summaryQuery.isLoading || inboxQuery.isLoading) return;
    if (prevCountRef.current !== null && totalCount > prevCountRef.current) {
      const diff = totalCount - prevCountRef.current;
      if (soundEnabled) playNotificationChime();
      notification.info({
        message: `Новые задачи или согласования (+${diff})`,
        description: urgent ? "Есть срочные уведомления — проверьте центр согласований." : "Появились новые уведомления для вашего участка.",
        placement: "topRight",
        duration: 6,
        btn: (
          <Button
            type="primary"
            size="small"
            onClick={() => {
              notification.destroy();
              onOpen(toApprove > 0 ? "approvals" : "inbox");
            }}
          >
            Открыть
          </Button>
        ),
      });
    }
    prevCountRef.current = totalCount;
  }, [totalCount, summaryQuery.isLoading, inboxQuery.isLoading, soundEnabled, urgent, toApprove, onOpen]);

  const btnStyle: React.CSSProperties = {
    minWidth: 40,
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  };

  if (totalCount === 0) {
    return (
      <span ref={btnRef} style={{ display: "inline-flex" }}>
        <Tooltip title="Центр согласований и задач">
          <Button
            type="text"
            style={btnStyle}
            icon={<BellOutlined style={{ color: "#fff", fontSize: 18 }} />}
            onClick={() => onOpen(toApprove > 0 ? "approvals" : "inbox")}
            aria-label="Уведомления и согласования"
          />
        </Tooltip>
      </span>
    );
  }

  const badgeColor = toApprove > 0 || urgent ? "#d4380d" : "#1677ff";

  return (
    <span ref={btnRef} style={{ display: "inline-flex" }}>
      <Tooltip title={`Согласований: ${toApprove}, задач: ${inboxCount}`}>
        <Badge count={totalCount} color={badgeColor} size="small" offset={[-4, 4]}>
          <Button
            type="text"
            style={btnStyle}
            icon={toApprove > 0 ? <ThunderboltFilled style={{ color: "#FFD666", fontSize: 18 }} /> : <BellOutlined style={{ color: "#fff", fontSize: 18 }} />}
            onClick={() => onOpen(toApprove > 0 ? "approvals" : "inbox")}
            aria-label="Уведомления и согласования"
          />
        </Badge>
      </Tooltip>
    </span>
  );
}


export default function AppLayout({ pageRoutes }: { pageRoutes: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [headerQuery, setHeaderQuery] = useState("");
  // На реальном планшете в портретной ориентации ширина шапки оказалась
  // заметно меньше, чем предполагалось (заголовок, поиск, QR, колокольчик
  // и имя пользователя в одну строку туда не помещались — наезжали друг
  // на друга). Вместо более тесной вёрстки — иконочная шапка: строка
  // поиска не стоит там постоянно, а разворачивается на всю ширину по
  // тапу на лупу и сворачивается обратно.
  const [searchOpen, setSearchOpen] = useState(false);
  const [verticalPrint, setVerticalPrintState] = useState(isVerticalPrint());
  const [printerIp, setPrinterIpState] = useState<string | null>(getSelectedPrinterIp());
  const [uxMode, setUxMode] = useState<UxMode>(() => getEffectiveUxMode(user));

  useEffect(() => {
    setUxMode(getEffectiveUxMode(user));
  }, [user]);
  const { data: printerStatus, refetch: refetchPrinterStatus, isFetching: printerChecking } = useQuery<{
    ok: boolean;
    code: string;
    message: string;
  }>({
    queryKey: ["printer-status", printerIp],
    queryFn: async () => {
      const { apiClient } = await import("../api/client");
      const { data } = await apiClient.get("/labels/printers/status", { params: { ip: printerIp } });
      return data;
    },
    enabled: !!user && !!printerIp,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [approvalsTab, setApprovalsTab] = useState<"approvals" | "inbox" | "signals">("approvals");
  // Короткое меню мастера: «Полное меню» в меню пользователя (запоминается на устройстве).
  const [fullMenu, setFullMenu] = useState<boolean>(() => {
    try {
      return localStorage.getItem("full-menu") === "1";
    } catch {
      return false;
    }
  });
  const [soundAlerts, setSoundAlerts] = useState<boolean>(() => {
    try {
      return localStorage.getItem("bdk:sound-alerts") !== "0";
    } catch {
      return true;
    }
  });
  const [tourOpen, setTourOpen] = useState(false);
  const searchBtnRef = useRef<HTMLButtonElement | null>(null);
  const qrWrapRef = useRef<HTMLSpanElement | null>(null);
  const bellWrapRef = useRef<HTMLSpanElement | null>(null);
  const profileBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const startTour = () => setTourOpen(true);
    window.addEventListener("bdk:start-tour", startTour);
    return () => window.removeEventListener("bdk:start-tour", startTour);
  }, []);
  // Раздел про телефонную версию — единственная уже используемая в
  // проекте конвенция "мобильный/десктоп" (ResponsiveTable.tsx). !sm —
  // именно телефон (<576px), не портретный планшет — тот должен остаться
  // на уже сделанной под него верхней навигации.
  const screens = Grid.useBreakpoint();
  const isPhone = !screens.sm;
  const isTablet = !screens.xl || (typeof window !== "undefined" && window.innerWidth <= 1280);
  useRealtimeSync(!!user);

  if (!user) return null;

  // Глобальный поиск в шапке (9.7 раздел бэклога доработок) — виден на
  // любом экране, не только на "Остатках".
  const runHeaderSearch = () => runUnitOrMaterialSearch(headerQuery, navigate);

  // Глобальный перехват аппаратного сканера ТСД / штрихкодов в любой части приложения
  useGlobalBarcodeScanner({
    onFallbackScan: (barcode) => {
      runUnitOrMaterialSearch(barcode, navigate);
    },
  });

  const isVisible = (item: NavItem) => isNavItemVisible(item, user);

  // Единое функциональное дерево (8.2 раздел бэклога доработок) — блоки без
  // заголовка отрисовываются как плоские пункты верхнего уровня, блоки с
  // заголовком ("Материалы (плёнка)", "Администрирование") — как
  // выпадающее подменю (раздел про адаптацию под планшет: боковая панель
  // заменена на горизонтальное меню под шапкой — children без явного type
  // в mode="horizontal" antd сам рисует как подменю, и сам же схлопывает
  // то, что не влезло по ширине, в пункт "…").
  // Короткое меню мастера — по умолчанию включено, выключается в меню пользователя.
  const master = isMasterUser(user);
  const shortMenu = master && !fullMenu;
  const items = shortMenu
    ? masterNav.filter(isVisible).map((item) => ({ key: item.path, label: item.label }))
    : navTree
    .map((block) => ({ block, visibleItems: block.items.filter(isVisible) }))
    .filter(({ visibleItems }) => visibleItems.length > 0)
    .flatMap(({ block, visibleItems }) =>
      block.label
        ? [
            {
              key: block.key,
              label: block.label,
              children: visibleItems.map((item) => ({ key: item.path, label: item.label })),
            },
          ]
        : visibleItems.map((item) => ({ key: item.path, label: item.label })),
    );

  // Пункты с вкладкой в адресе (/nomenclature?tab=types) подсвечиваются точно.
  const navPaths = new Set([...navTree.flatMap((b) => b.items.map((i) => i.path)), ...masterNav.map((i) => i.path)]);

  const userMenuItems: MenuProps["items"] = [
    {
      key: "info",
      label: (
        <div style={{ lineHeight: 1.4, padding: "2px 0" }}>
          <div>{user.full_name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {user.is_superuser ? "Суперпользователь" : user.roles.map((r) => r.name).join(", ") || "без роли"}
          </Typography.Text>
        </div>
      ),
      disabled: true,
    },
    { type: "divider" },
    {
      // запросы администратору (28.10): раньше — значок в шапке; ответы — в «Ждёт меня»
      key: "my-requests",
      label: "Мои запросы администратору",
      onClick: () => navigate("/requests?section=actions"),
    },
    {
      key: "help",
      label: "Что мне тут делать? (подсказка)",
      icon: <QuestionCircleOutlined />,
      onClick: () => navigate("/", { state: { showOnboarding: true } }),
    },
    {
      key: "tour",
      label: "Пройти короткий тур по экрану",
      icon: <QuestionCircleOutlined />,
      onClick: () => setTourOpen(true),
    },
    { type: "divider" },
    {
      key: "sound-alerts",
      label: (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, minWidth: 220 }}
        >
          <span>Звук уведомлений</span>
          <Switch
            size="small"
            checked={soundAlerts}
            onChange={(checked) => {
              setSoundAlerts(checked);
              try {
                localStorage.setItem("bdk:sound-alerts", checked ? "1" : "0");
              } catch {
                /* ignore */
              }
            }}
          />
        </div>
      ),
    },
    { type: "divider" },
    {
      key: "vertical-print",
      label: (
        // Раздел про ориентацию печати — переключатель прямо в меню
        // пользователя, чтобы применялся сразу ко всем этикеткам на этом
        // устройстве (принтер/место наклейки не меняется от экрана к
        // экрану), без отдельной кнопки на каждом из них. stopPropagation
        // — иначе клик по свитчу закрывает выпадающее меню, как обычный
        // пункт.
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, minWidth: 220 }}
        >
          <span>Печать этикеток вертикально</span>
          <Switch
            size="small"
            checked={verticalPrint}
            onChange={(checked) => {
              setVerticalPrint(checked);
              setVerticalPrintState(checked);
            }}
          />
        </div>
      ),
    },
    {
      key: "ux-mode",
      label: (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, minWidth: 220 }}
        >
          <span>Терминал цеха/склада</span>
          <Switch
            size="small"
            checked={uxMode === "terminal"}
            onChange={(checked) => {
              const next: UxMode = checked ? "terminal" : "office";
              setStoredUxMode(next);
              setUxMode(next);
              window.dispatchEvent(new Event("bdk-ux-mode-change"));
            }}
          />
        </div>
      ),
    },
    {
      key: "printer-select",
      label: (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 240 }}
        >
          <span style={{ fontSize: 12, color: "var(--bdk-ink-2)" }}>Принтер этикеток:</span>
          <Select
            size="small"
            value={printerIp ?? "__browser__"}
            onChange={(val) => {
              const next = val === "__browser__" ? null : val;
              setSelectedPrinterIp(next);
              setPrinterIpState(next);
            }}
            options={[
              { value: "__browser__", label: "Браузер / GoApp (по умолчанию)" },
              ...NETWORK_PRINTERS.map((p) => ({ value: p.ip, label: p.name })),
            ]}
          />
          {printerIp && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <Tag color={printerStatus?.ok ? "green" : "red"} style={{ margin: 0, fontSize: 11, whiteSpace: "normal" }}>
                {printerChecking ? "Проверка…" : (printerStatus?.message ?? "Нет данных")}
              </Tag>
              <Button size="small" type="link" style={{ padding: 0, height: "auto", fontSize: 11 }} onClick={() => refetchPrinterStatus()}>
                Проверить
              </Button>
            </div>
          )}
        </div>
      ),
    },
    ...(master
      ? [
          { type: "divider" as const },
          {
            key: "full-menu",
            label: (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, minWidth: 220 }}
              >
                <span>Полное меню</span>
                <Switch
                  size="small"
                  checked={fullMenu}
                  onChange={(checked) => {
                    setFullMenu(checked);
                    try {
                      localStorage.setItem("full-menu", checked ? "1" : "0");
                    } catch {
                      /* не запоминаем */
                    }
                  }}
                />
              </div>
            ),
          },
        ]
      : []),
    { type: "divider" },
    { key: "password", label: "Сменить пароль", icon: <KeyOutlined />, onClick: () => setPasswordOpen(true) },
    {
      key: "logout",
      label: "Выйти",
      icon: <LogoutOutlined />,
      onClick: () => {
        logout();
        navigate("/login");
      },
    },
  ];

  const closeSearch = () => {
    setSearchOpen(false);
    setHeaderQuery("");
  };
  const submitHeaderSearch = () => {
    if (!headerQuery.trim()) return;
    runHeaderSearch();
    closeSearch();
  };
  const recentSearches = searchOpen ? getRecentSearches() : [];

  return (
    // height: 100svh (а не 100vh) + overflow: hidden на внешнем Layout —
    // шапка и меню несжимаемая рамка приложения, прокручивается только
    // содержимое конкретного экрана (Content), а не вся страница. 100vh на
    // телефоне включает область ПОД адресной строкой браузера — реальная
    // видимая высота при обычной, не свёрнутой адресной строке меньше, из-
    // за чего нижняя панель вкладок (PhoneTabBar) уезжала за пределы
    // видимого экрана и появлялась только после скролла (он схлопывает
    // адресную строку). 100svh — всегда высота с учётом развёрнутой
    // адресной строки, панель видна сразу, без скролла. Класс (не inline
    // style) — 100svh нужен запасной вариант 100vh на случай, если
    // конкретный WebView его не понимает (см. index.css), а inline style
    // не может держать две строки на одно и то же свойство.
    <Layout className="app-shell" style={{ overflow: "hidden" }}>
      {/* с клавиатуры — сразу к экрану, не проходя шапку и меню (16.10) */}
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Перейти к содержимому
      </a>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          gap: 6,
          flexShrink: 0,
          height: isTablet ? 46 : 56,
          lineHeight: isTablet ? "46px" : "56px",
        }}
      >
        {searchOpen ? (
          // Раскрытый поиск занимает всю шапку — так на любой ширине
          // (даже самой тесной портретной) под сам ввод остаётся вся
          // строка, а не сжатый огрызок рядом с логотипом и иконками.
          <>
            <Button
              type="text"
              style={{ minWidth: 40, height: 40, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0 }}
              icon={<ArrowLeftOutlined style={{ color: "#fff", fontSize: 18 }} />}
              onClick={closeSearch}
              aria-label="Закрыть поиск"
            />
            <Input
              autoFocus
              allowClear
              // enterKeyHint — на планшете (Android) при нескольких полях
              // ввода на странице виртуальная клавиатура иначе показывает
              // "Далее" вместо "Найти" и просто переводит фокус на
              // следующее поле, ни разу не вызывая onPressEnter (баг:
              // "поиск просто открывает страницу без фильтра" — клавиша
              // Enter до обработчика не долетала именно там, где на
              // странице ниже есть другие поля, т.е. на "Остатках").
              enterKeyHint="search"
              prefix={<SearchOutlined />}
              placeholder="Номер или название: деталь, задание, заказ, счёт, плёнка…"
              value={headerQuery}
              onChange={(e) => setHeaderQuery(e.target.value)}
              onPressEnter={submitHeaderSearch}
              style={{ flex: "1 1 auto", minWidth: 0, height: isTablet ? 36 : 40 }}
            />
            <Button
              type="primary"
              onClick={submitHeaderSearch}
              disabled={!headerQuery.trim()}
              style={{ height: isTablet ? 36 : 40, flexShrink: 0 }}
            >
              Найти
            </Button>
          </>
        ) : (
          <>
            <Typography.Title
              level={4}
              style={{
                color: "#fff",
                margin: 0,
                fontFamily: fontHeading,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
                fontSize: isTablet ? 17 : 20,
              }}
            >
              {isPhone ? "БДК" : "Учёт плёнки БДК"}
            </Typography.Title>
            <div style={{ flex: "1 1 auto" }} />
            <Button
              ref={searchBtnRef}
              type="text"
              style={{ minWidth: 40, height: 40, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0 }}
              icon={<SearchOutlined style={{ color: "#fff", fontSize: 18 }} />}
              onClick={() => setSearchOpen(true)}
              aria-label="Поиск"
            />
            <span ref={qrWrapRef} style={{ display: "inline-flex" }}>
              <QrScanButton
                onScan={(code) => runUnitOrMaterialSearch(code, navigate, "scan")}
                tooltip="Сканировать QR камерой"
                type="primary"
                style={{ minWidth: 40, height: 40, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              />
            </span>
            <HeaderNotificationsButton
              btnRef={bellWrapRef}
              soundEnabled={soundAlerts}
              onOpen={(tab) => { setApprovalsTab(tab); setApprovalsOpen(true); }}
            />
            <Dropdown menu={{ items: userMenuItems }} trigger={["click"]} placement="bottomRight">
              {/* кнопка, а не картинка — доступна с клавиатуры и скринридеру (14.10) */}
              <Button
                ref={profileBtnRef}
                type="text"
                aria-label="Профиль и выход"
                style={{ minWidth: 40, height: 40, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
              >
                <Avatar icon={<UserOutlined />} size={isTablet ? 30 : 34} style={{ cursor: "pointer", backgroundColor: "rgba(255,255,255,0.2)" }} />
              </Button>
            </Dropdown>
          </>
        )}
      </Header>
      {searchOpen && recentSearches.length > 0 && (
        <div
          style={{
            background: "#fff",
            borderBottom: "1px solid #EAE8E2",
            padding: "6px 12px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            flexShrink: 0,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Недавние:
          </Typography.Text>
          <Space size={4} wrap>
            {recentSearches.map((item) => (
              <Tag
                key={item.query}
                style={{ cursor: "pointer", margin: 0 }}
                onClick={() => {
                  runUnitOrMaterialSearch(item.query, navigate);
                  closeSearch();
                }}
              >
                {item.label}
              </Tag>
            ))}
          </Space>
        </div>
      )}
      {/* Горизонтальное меню вместо боковой панели (раздел про адаптацию
          под планшет — боковая колонка отъедала до 240px ширины даже в
          свёрнутом с иконками виде, а на планшете каждый пиксель на счету).
          mode="horizontal" сам собирает пункты, которые не влезли, в
          выпадающий пункт "…" — прокрутки/переполнения здесь не бывает.
          На телефоне (isPhone) вместо этого — нижняя панель вкладок ниже
          Content, верхнее меню туда физически не помещается. */}
      {!isPhone && (
        <div ref={menuWrapRef} style={{ flexShrink: 0 }}>
          <Menu
            mode="horizontal"
            overflowedIndicator={<span>Ещё ▾</span>}
            style={{
              height: isTablet ? 38 : 46,
              lineHeight: isTablet ? "38px" : "46px",
              fontSize: isTablet ? 13 : 14,
            }}
            selectedKeys={[navPaths.has(location.pathname + location.search) ? location.pathname + location.search : location.pathname]}
            items={items}
            onClick={(e) => navigate(e.key)}
          />
        </div>
      )}
      <OfflineBanner />
      {/* minWidth: 0 — без этого antd Layout не даёт Content сжаться уже
          своей колонки: широкая таблица внутри раздвигала всю страницу
          вместо прокрутки в своих рамках. overflow: auto (не только X) —
          именно Content, а не вся страница, отвечает за вертикальную
          прокрутку экрана. */}
      {isPhone ? (
        <Content id="main" tabIndex={-1} className="app-page" style={{ minWidth: 0, overflow: "auto", flex: "1 1 auto", minHeight: 0, outline: "none" }}>
          <Outlet />
        </Content>
      ) : (
        // Планшет и компьютер — рабочие вкладки, как в 1С (WorkspaceTabs):
        // карточка открывается своей вкладкой, список остаётся со своими
        // фильтрами; прокрутка — у каждой вкладки своя.
        <Content id="main" tabIndex={-1} style={{ padding: 0, minWidth: 0, overflow: "hidden", flex: "1 1 auto", minHeight: 0, outline: "none" }}>
          <WorkspaceTabs pageRoutes={pageRoutes} />
        </Content>
      )}
      {/* Нижняя панель вкладок на телефоне — ещё один flexShrink:0 сосед
          внутри уже существующей рамки height:100vh/overflow:hidden, тем
          же приёмом, что Header/Menu/OfflineBanner выше: естественно
          прижимается к низу без position:fixed и без компенсирующих
          отступов у Content. */}
      {isPhone && <PhoneTabBar onManualSearchRequest={() => setSearchOpen(true)} />}
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      {/* После сброса администратором — сразу задать свой, окно не закрыть. */}
      <ChangePasswordModal open={!!user.must_change_password} onClose={() => undefined} forced />
      {/* «Попросить администратора» на любое запрещённое действие (07.10) */}
      <ActionRequestPrompt />
      <ApprovalsDrawer open={approvalsOpen} onClose={() => setApprovalsOpen(false)} defaultTab={approvalsTab} />
      <Tour
        open={tourOpen}
        onClose={() => setTourOpen(false)}
        steps={[
          ...(!isPhone
            ? [
                {
                  title: "Разделы программы",
                  description: "Основные рабочие центры всегда перед глазами. Если пункты не помещаются на планшете, откройте «Ещё ▾».",
                  target: () => menuWrapRef.current!,
                },
              ]
            : []),
          {
            title: "Быстрый поиск",
            description: "Введите номер рулона, партии, заказа или название материала — и нажмите «Найти». Здесь же сохраняются 5 последних поисков.",
            target: () => searchBtnRef.current!,
          },
          {
            title: "Сканер QR",
            description: "Наведите камеру на этикетку рулона, партии или стеллажа, чтобы мгновенно открыть нужную карточку.",
            target: () => qrWrapRef.current!,
          },
          {
            title: "Уведомления и согласования",
            description: "Здесь появляются новые задания, срочные сигналы и заявки на согласование.",
            target: () => bellWrapRef.current!,
          },
          {
            title: "Профиль и настройки устройства",
            description: "Смена пароля, ориентация этикеток, звук уведомлений и повторный запуск подсказки.",
            target: () => profileBtnRef.current!,
          },
        ] as TourProps["steps"]}
      />
    </Layout>
  );
}
