import { useState } from "react";
import { Layout, Menu, Typography, Button, Input, Avatar, Dropdown } from "antd";
import type { MenuProps } from "antd";
import { MenuOutlined, SearchOutlined, ArrowLeftOutlined, UserOutlined, LogoutOutlined } from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { navTree, type NavItem } from "./navConfig";
import { fontHeading } from "../theme";
import { runUnitOrMaterialSearch } from "../utils/unitSearch";
import QrScanButton from "../components/QrScanButton";
import OfflineBanner from "../components/OfflineBanner";
import NotificationBell from "../components/NotificationBell";

const { Header, Sider, Content } = Layout;

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [headerQuery, setHeaderQuery] = useState("");
  // Раздел про адаптацию под планшет — свой toggle в шапке вместо
  // стандартного плавающего триггера antd (Sider trigger={null}): тот
  // рисуется поверх контента абсолютным позиционированием и на узких
  // экранах перекрывал первую плитку/строку страницы. Начальное значение
  // — сразу по ширине окна, чтобы не было мигания "открыто → схлопнулось".
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 992);
  // На реальном планшете в портретной ориентации ширина шапки оказалась
  // заметно меньше, чем предполагалось (заголовок, поиск, QR, колокольчик
  // и имя пользователя в одну строку туда не помещались — наезжали друг
  // на друга). Вместо более тесной вёрстки — иконочная шапка: строка
  // поиска не стоит там постоянно, а разворачивается на всю ширину по
  // тапу на лупу и сворачивается обратно.
  const [searchOpen, setSearchOpen] = useState(false);

  if (!user) return null;

  // Глобальный поиск в шапке (9.7 раздел бэклога доработок) — виден на
  // любом экране, не только на "Остатках".
  const runHeaderSearch = () => runUnitOrMaterialSearch(headerQuery, navigate);

  const isVisible = (item: NavItem) => {
    if (!user.is_superuser && item.permissions?.length && !item.permissions.some((p) => user.permissions.includes(p))) {
      return false;
    }
    if (item.areas && !(user.area && item.areas.includes(user.area))) return false;
    return true;
  };

  // Единое функциональное дерево (8.2 раздел бэклога доработок) — блоки без
  // заголовка отрисовываются как плоские пункты верхнего уровня, блоки с
  // заголовком ("Планирование", "Администрирование") — как группа.
  const items = navTree
    .map((block) => ({ block, visibleItems: block.items.filter(isVisible) }))
    .filter(({ visibleItems }) => visibleItems.length > 0)
    .flatMap(({ block, visibleItems }) =>
      block.label
        ? [
            {
              key: block.key,
              label: block.label,
              type: "group" as const,
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
    // height: 100vh + overflow: hidden на внешнем Layout вместо просто
    // minHeight — раньше шапка и меню были в обычном потоке страницы: если
    // список пунктов меню (с учётом раздела "Администрирование") был выше
    // короткого экрана (планшет в альбомной ориентации), не помещавшиеся
    // пункты можно было увидеть только прокруткой ВСЕЙ страницы — вместе с
    // шапкой, которая тоже уезжала наверх и терялась из виду ("нет
    // админских функций" — на деле они просто были ниже видимой области).
    // Теперь шапка и меню — несжимаемая рамка приложения, а прокручивается
    // только содержимое конкретного экрана (Content) и, если пунктов меню
    // больше, чем помещается, — само меню внутри своей колонки.
    <Layout style={{ height: "100vh", overflow: "hidden" }}>
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
            <Button
              type="text"
              icon={<MenuOutlined style={{ color: "#fff" }} />}
              onClick={() => setCollapsed((c) => !c)}
              aria-label="Показать/скрыть меню"
            />
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
      <OfflineBanner />
      <Layout style={{ flex: "1 1 auto", minHeight: 0 }}>
        <Sider
          width={240}
          collapsedWidth={0}
          collapsed={collapsed}
          onCollapse={setCollapsed}
          breakpoint="lg"
          trigger={null}
          style={{ flexShrink: 0, overflowY: "auto" }}
        >
          <Menu
            theme="dark"
            mode="inline"
            style={{ height: "100%" }}
            selectedKeys={[location.pathname]}
            items={items}
            onClick={(e) => navigate(e.key)}
          />
        </Sider>
        {/* minWidth: 0 — без этого antd Layout не даёт Content сжаться уже
            своей колонки: широкая таблица внутри раздвигала всю страницу
            (и сайдбар вместе с ней) вместо прокрутки в своих рамках.
            overflow: auto (не только X) — теперь именно Content, а не вся
            страница, отвечает за вертикальную прокрутку экрана. */}
        <Content style={{ padding: 24, minWidth: 0, overflow: "auto" }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
