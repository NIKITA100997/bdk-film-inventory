import { Button, Space } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import InventoryDesktop from "./InventoryDesktop";
import StockCounts from "./StockCounts";

/** Инвентаризация — одна на все виды, по месту (27.10): плёнка, п/ф,
 * материалы и изделия — одним листом места (StockCounts). Прежние пересчёты
 * плёнки сканом по стеллажу — архивом (?tab=film-archive), новых там не начинают. */
export default function Inventory() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canFilm = !!user?.is_superuser || !!user?.permissions.includes("inventory.manage");
  if (canFilm && params.get("tab") === "film-archive") {
    return (
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Button type="link" style={{ padding: 0 }} onClick={() => setParams({})}>
          ← Инвентаризация
        </Button>
        <InventoryDesktop />
      </Space>
    );
  }
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div />
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          onClick={() => navigate("/inventory/express")}
          style={{ background: "#722ed1", borderColor: "#722ed1" }}
        >
          📱 Экспресс-ревизия у стеллажа (для планшета)
        </Button>
      </div>
      <StockCounts />
      {canFilm && !params.get("count") && (
        <Button type="link" style={{ padding: 0 }} onClick={() => setParams({ tab: "film-archive" })}>
          Прежние пересчёты плёнки сканом по стеллажу (до 27.10)
        </Button>
      )}
    </Space>
  );
}
