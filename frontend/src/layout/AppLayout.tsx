import { useState } from "react";
import { Layout, Menu, Grid, Typography, Button, Input, Avatar, Dropdown, Switch } from "antd";
import type { MenuProps } from "antd";
import { SearchOutlined, ArrowLeftOutlined, UserOutlined, LogoutOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { navTree, isNavItemVisible, type NavItem } from "./navConfig";
import { fontHeading } from "../theme";
import { runUnitOrMaterialSearch } from "../utils/unitSearch";
import { isVerticalPrint, setVerticalPrint } from "../utils/printLabel";
import QrScanButton from "../components/QrScanButton";
import OfflineBanner from "../components/OfflineBanner";
import NotificationBell from "../components/NotificationBell";
import PhoneTabBar from "./PhoneTabBar";

const { Header, Content } = Layout;

export default function AppLayout() {
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
  // Раздел про телефонную версию — единственная уже используемая в
  // проекте конвенция "мобильный/десктоп" (ResponsiveTable.tsx). !sm —
  // именно телефон (<576px), не портретный планшет — тот должен остаться
  // на уже сделанной под него верхней навигации.
  const screens = Grid.useBreakpoint();
  const isPhone = !screens.sm;

  if (!user) return null;

  // Глобальный поиск в шапке (9.7 раздел бэклога доработок) — виден на
  // любом экране, не только на "Остатках".
  const runHeaderSearch = () => runUnitOrMaterialSearch(headerQuery, navigate);

  const isVisible = (item: NavItem) => isNavItemVisible(item, user);

  // Единое функциональное дерево (8.2 раздел бэклога доработок) — блоки без
  // заголовка отрисовываются как плоские пункты верхнего уровня, блоки с
  // заголовком ("Складские операции", "Администрирование") — как
  // выпадающее подменю (раздел про адаптацию под планшет: боковая панель
  // заменена на горизонтальное меню под шапкой — children без явного type
  // в mode="horizontal" antd сам рисует как подменю, и сам же схлопывает
  // то, что не влезло по ширине, в пункт "…").
  const items = navTree
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
      // Повторное открытие приветственной карточки (раздел 16 бэклога
      // доработок — онбординг) — не отдельная иконка в шапке, там и так
      // тесно на планшете (см. комментарий про searchOpen ниже), а пункт
      // в уже существующем меню пользователя, тем же паттерном
      // navigate(path,{state}), что и runUnitOrMaterialSearch.
      key: "help",
      label: "Что мне тут делать? (подсказка)",
      icon: <QuestionCircleOutlined />,
      onClick: () => navigate("/", { state: { showOnboarding: true } }),
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
    { type: "divider" },
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

  return (
    // height: 100svh (а не 100vh) + overflow: hidden на внешнем Layout —
    // шапка и меню несжимаемая рамка приложения, прокручивается только
    // содержимое конкретного экрана (Content), а не вся страница. 100vh на
    // телефоне включает область ПОД адресной строкой браузера — реальная
    // видимая высота при обычной, не свёрнутой адресной строке меньше, из-
    // за чего нижняя панель вкладок (PhoneTabBar) уезжала за пределы
    // видимого экрана и появлялась только после скролла (он схлопывает
    // адресную строку). 100svh — всегда высота с учётом развёрнутой
    // адресной строки, панель видна сразу, без скролла.
    <Layout style={{ height: "100svh", overflow: "hidden" }}>
      <Header style={{ display: "flex", alignItems: "center", padding: "0 8px", gap: 4, flexShrink: 0 }}>
        {searchOpen ? (
          // Раскрытый поиск занимает всю шапку — так на любой ширине
          // (даже самой тесной портретной) под сам ввод остаётся вся
          // строка, а не сжатый огрызок рядом с логотипом и иконками.
          <>
            <Button
              type="text"
              icon={<ArrowLeftOutlined style={{ color: "#fff" }} />}
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
              placeholder="ID единицы или материал…"
              value={headerQuery}
              onChange={(e) => setHeaderQuery(e.target.value)}
              onPressEnter={() => {
                runHeaderSearch();
                closeSearch();
              }}
              style={{ flex: "1 1 auto", minWidth: 0 }}
            />
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
              }}
            >
              Учёт плёнки БДК
            </Typography.Title>
            <div style={{ flex: "1 1 auto" }} />
            <Button
              type="text"
              icon={<SearchOutlined style={{ color: "#fff" }} />}
              onClick={() => setSearchOpen(true)}
              aria-label="Поиск по ID/материалу"
            />
            <QrScanButton
              onScan={(code) => runUnitOrMaterialSearch(code, navigate)}
              tooltip="Сканировать QR камерой"
              type="primary"
            />
            <NotificationBell />
            <Dropdown menu={{ items: userMenuItems }} trigger={["click"]} placement="bottomRight">
              <Avatar
                icon={<UserOutlined />}
                style={{ cursor: "pointer", backgroundColor: "rgba(255,255,255,0.2)", flexShrink: 0 }}
              />
            </Dropdown>
          </>
        )}
      </Header>
      {/* Горизонтальное меню вместо боковой панели (раздел про адаптацию
          под планшет — боковая колонка отъедала до 240px ширины даже в
          свёрнутом с иконками виде, а на планшете каждый пиксель на счету).
          mode="horizontal" сам собирает пункты, которые не влезли, в
          выпадающий пункт "…" — прокрутки/переполнения здесь не бывает.
          На телефоне (isPhone) вместо этого — нижняя панель вкладок ниже
          Content, верхнее меню туда физически не помещается. */}
      {!isPhone && (
        <Menu
          mode="horizontal"
          style={{ flexShrink: 0 }}
          selectedKeys={[location.pathname]}
          items={items}
          onClick={(e) => navigate(e.key)}
        />
      )}
      <OfflineBanner />
      {/* minWidth: 0 — без этого antd Layout не даёт Content сжаться уже
          своей колонки: широкая таблица внутри раздвигала всю страницу
          вместо прокрутки в своих рамках. overflow: auto (не только X) —
          именно Content, а не вся страница, отвечает за вертикальную
          прокрутку экрана. */}
      <Content style={{ padding: 24, minWidth: 0, overflow: "auto", flex: "1 1 auto", minHeight: 0 }}>
        <Outlet />
      </Content>
      {/* Нижняя панель вкладок на телефоне — ещё один flexShrink:0 сосед
          внутри уже существующей рамки height:100vh/overflow:hidden, тем
          же приёмом, что Header/Menu/OfflineBanner выше: естественно
          прижимается к низу без position:fixed и без компенсирующих
          отступов у Content. */}
      {isPhone && <PhoneTabBar onManualSearchRequest={() => setSearchOpen(true)} />}
    </Layout>
  );
}
