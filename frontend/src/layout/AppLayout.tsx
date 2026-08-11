import { useState } from "react";
import { Layout, Menu, Space, Typography, Button, Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { navTree, type NavItem } from "./navConfig";
import { fontHeading, palette } from "../theme";
import { runUnitOrMaterialSearch } from "../utils/unitSearch";

const { Header, Sider, Content } = Layout;

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [headerQuery, setHeaderQuery] = useState("");

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
      <Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography.Title level={4} style={{ color: "#fff", margin: 0, fontFamily: fontHeading, whiteSpace: "nowrap" }}>
          Учёт плёнки БДК
        </Typography.Title>
        <Input
          prefix={<SearchOutlined />}
          placeholder="ID единицы или материал…"
          value={headerQuery}
          onChange={(e) => setHeaderQuery(e.target.value)}
          onPressEnter={runHeaderSearch}
          style={{ maxWidth: 320, margin: "0 16px" }}
        />
        <Space>
          <Typography.Text style={{ color: palette.grayMuted }}>
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
      <Layout>
        <Sider width={240} breakpoint="md" collapsedWidth={0}>
          <Menu
            theme="dark"
            mode="inline"
            style={{ height: "100%" }}
            selectedKeys={[location.pathname]}
            items={items}
            onClick={(e) => navigate(e.key)}
          />
        </Sider>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
