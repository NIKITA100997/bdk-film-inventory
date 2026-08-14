import { useState } from "react";
import { Layout, Menu, Space, Typography, Button, Input } from "antd";
import { MenuOutlined, SearchOutlined } from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { navTree, type NavItem } from "./navConfig";
import { fontHeading, palette } from "../theme";
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

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", gap: 12 }}>
        <Space style={{ flexShrink: 0 }}>
          <Button
            type="text"
            icon={<MenuOutlined style={{ color: "#fff" }} />}
            onClick={() => setCollapsed((c) => !c)}
            aria-label="Показать/скрыть меню"
          />
          <Typography.Title level={4} style={{ color: "#fff", margin: 0, fontFamily: fontHeading, whiteSpace: "nowrap" }}>
            Учёт плёнки БДК
          </Typography.Title>
        </Space>
        <Space style={{ minWidth: 0, flex: "1 1 auto", justifyContent: "center" }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="ID единицы или материал…"
            value={headerQuery}
            onChange={(e) => setHeaderQuery(e.target.value)}
            onPressEnter={runHeaderSearch}
            style={{ width: 200, maxWidth: "40vw" }}
          />
          <QrScanButton
            onScan={(code) => runUnitOrMaterialSearch(code, navigate)}
            tooltip="Сканировать QR камерой"
            type="primary"
          />
          <NotificationBell />
        </Space>
        <Space style={{ flexShrink: 0 }}>
          {/* ellipsis вместо голого текста — без него на узком экране (планшет)
              строка "Имя · Роль" переносится на несколько строк и вылезает
              за пределы шапки высотой 64px вверх и вниз. */}
          <Typography.Text style={{ color: palette.grayMuted, maxWidth: 160 }} ellipsis={{ tooltip: true }}>
            {user.full_name} · {user.is_superuser ? "Суперпользователь" : user.roles.map((r) => r.name).join(", ") || "без роли"}
          </Typography.Text>
          <Button
            type="text"
            style={{ color: "#fff" }}
            onClick={() => {
              logout();
              navigate("/login");
            }}
          >
            Выйти
          </Button>
        </Space>
      </Header>
      <OfflineBanner />
      <Layout>
        <Sider
          width={240}
          collapsedWidth={0}
          collapsed={collapsed}
          onCollapse={setCollapsed}
          breakpoint="lg"
          trigger={null}
          style={{ flexShrink: 0 }}
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
            (и сайдбар вместе с ней) вместо прокрутки в своих рамках. */}
        <Content style={{ padding: 24, minWidth: 0, overflowX: "auto" }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
