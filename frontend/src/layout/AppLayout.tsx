import { Layout, Menu, Space, Typography, Button } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { desktopSections, mobileBlocks, type NavItem } from "./navConfig";
import { fontHeading, palette } from "../theme";

const { Header, Sider, Content } = Layout;

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  if (!user) return null;

  const isVisible = (item: NavItem) => {
    if (user.role !== "admin" && !item.roles.includes(user.role)) return false;
    if (item.areas && !(user.area && item.areas.includes(user.area))) return false;
    return true;
  };

  // Мобильные блоки и десктопные разделы (5.5 ТЗ) отрисовываются как группы
  // в одном боковом меню — конкретному пользователю обычно видна только
  // "своя" половина (складские/участковые роли — мобильные блоки, офисные —
  // десктопные разделы), кроме admin, который видит всё.
  const items = [...mobileBlocks, ...desktopSections]
    .map((block) => ({ block, visibleItems: block.items.filter(isVisible) }))
    .filter(({ visibleItems }) => visibleItems.length > 0)
    .map(({ block, visibleItems }) => ({
      key: block.key,
      label: block.label,
      type: "group" as const,
      children: visibleItems.map((item) => ({ key: item.path, label: item.label })),
    }));

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography.Title level={4} style={{ color: "#fff", margin: 0, fontFamily: fontHeading }}>
          Учёт плёнки БДК
        </Typography.Title>
        <Space>
          <Typography.Text style={{ color: palette.grayMuted }}>
            {user.full_name} · {user.role}
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
