import { Card, Col, Row, Tag, Typography } from "antd";
import {
  AppstoreOutlined,
  BarcodeOutlined,
  BuildOutlined,
  InboxOutlined,
  PrinterOutlined,
  ScissorOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import QrScanButton from "../../components/QrScanButton";
import { fontHeading } from "../../theme";
import { getSelectedPrinterIp, NETWORK_PRINTERS } from "../../utils/printLabel";
import { runUnitOrMaterialSearch } from "../../utils/unitSearch";

interface TerminalTile {
  key: string;
  title: string;
  subtitle: string;
  path: string;
  icon: React.ReactNode;
  accent: string;
  permissions?: string[];
}

const TILES: TerminalTile[] = [
  {
    key: "film-ops",
    title: "Операции с плёнкой",
    subtitle: "Приёмка, резка, выдача на участок, возврат",
    path: "/film-operations",
    icon: <ScissorOutlined style={{ fontSize: 36 }} />,
    accent: "#1677ff",
    permissions: ["units.receive", "units.issue", "units.return"],
  },
  {
    key: "tasks",
    title: "Задания участка",
    subtitle: "Сменные задания и отчёт по выпуску",
    path: "/production-tasks",
    icon: <BuildOutlined style={{ fontSize: 36 }} />,
    accent: "#1D9E75",
    permissions: ["production_tasks.report", "production_tasks.view", "production_tasks.manage"],
  },
  {
    key: "stock",
    title: "Склад и остатки",
    subtitle: "Поиск рулонов, штрипсов и ПФ",
    path: "/stock",
    icon: <InboxOutlined style={{ fontSize: 36 }} />,
    accent: "#722ed1",
  },
  {
    key: "stock-ops",
    title: "Партии и перемещения",
    subtitle: "Перемещение по ячейкам и списание",
    path: "/stock?tab=lots",
    icon: <SwapOutlined style={{ fontSize: 36 }} />,
    accent: "#fa8c16",
    permissions: ["units.issue", "units.receive", "units.return", "part_units.manage"],
  },
  {
    key: "nomenclature",
    title: "Карточки ПФ и ГП",
    subtitle: "Остатки полуфабрикатов и готовой продукции",
    path: "/nomenclature",
    icon: <AppstoreOutlined style={{ fontSize: 36 }} />,
    accent: "#13c2c2",
    permissions: ["part_units.view", "part_units.manage", "materials.manage"],
  },
  {
    key: "orders",
    title: "Заказы в работу",
    subtitle: "Просмотр текущих заказов клиентов",
    path: "/customer-orders",
    icon: <BarcodeOutlined style={{ fontSize: 36 }} />,
    accent: "#eb2f96",
    permissions: ["production_tasks.report", "production_tasks.view", "production_tasks.manage"],
  },
];

export default function TerminalHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const perms = new Set(user?.permissions ?? []);
  const isAll = perms.has("*");

  const visibleTiles = TILES.filter(
    (t) => !t.permissions || isAll || t.permissions.some((p) => perms.has(p)),
  );

  const printerIp = getSelectedPrinterIp();
  const printerName = NETWORK_PRINTERS.find((p) => p.ip === printerIp)?.name ?? "Браузер / GoApp";

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "8px 4px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0, fontFamily: fontHeading }}>
            Терминал цеха и склада
          </Typography.Title>
          <Typography.Text type="secondary">
            {user?.full_name || user?.username} — выберите операцию
          </Typography.Text>
        </div>
        <Tag icon={<PrinterOutlined />} color={printerIp ? "blue" : "default"} style={{ margin: 0, padding: "4px 10px", fontSize: 13 }}>
          {printerName}
        </Tag>
      </div>

      <div style={{ marginBottom: 16 }}>
        <QrScanButton
          type="primary"
          size="large"
          block
          buttonText="Сканировать QR-код"
          onScan={(code) => runUnitOrMaterialSearch(code, navigate)}
          style={{ height: 54, fontSize: 17, fontWeight: 700, borderRadius: 12 }}
        />
      </div>

      <Row gutter={[16, 16]}>
        {visibleTiles.map((tile) => (
          <Col key={tile.key} xs={24} sm={12} md={8}>
            <Card
              hoverable
              onClick={() => navigate(tile.path)}
              style={{
                minHeight: 138,
                borderRadius: 14,
                borderTop: `4px solid ${tile.accent}`,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
              }}
              styles={{ body: { padding: "20px 18px" } }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ color: tile.accent, flexShrink: 0 }}>{tile.icon}</div>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.25, marginBottom: 4 }}>
                    {tile.title}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--bdk-ink-2)" }}>{tile.subtitle}</div>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
