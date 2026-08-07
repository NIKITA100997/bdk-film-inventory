import { Layout, Menu, Space, Typography, Button } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { allNav } from "./navConfig";
import { fontHeading, palette } from "../theme";

const { Header, Sider, Content } = Layout;

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  if (!user) return null;

  const items = allNav
    .filter((item) => user.role === "admin" || item.roles.includes(user.role))
    .map((item) => ({ key: item.path, label: item.label }));

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
