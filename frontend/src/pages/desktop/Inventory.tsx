import { Button, Space } from "antd";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import InventoryDesktop from "./InventoryDesktop";
import StockCounts from "./StockCounts";

/** Инвентаризация — одна на все виды, по месту (27.10): плёнка, п/ф,
 * материалы и изделия — одним листом места (StockCounts). Прежние пересчёты
 * плёнки сканом по стеллажу — архивом (?tab=film-archive), новых там не начинают. */
export default function Inventory() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const canFilm = !!user?.is_superuser || !!user?.permissions.includes("inventory.manage");
  if (canFilm && params.get("tab") === "film-archive") {
    return (
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Button type="link" style={{ padding: 0 }} onClick={() => setParams({})}>
          ← Инвентаризация
        </Button>
        <InventoryDesktop />
      </Space>
    );
  }
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <StockCounts />
      {canFilm && !params.get("count") && (
        <Button type="link" style={{ padding: 0 }} onClick={() => setParams({ tab: "film-archive" })}>
          Прежние пересчёты плёнки сканом по стеллажу (до 27.10)
        </Button>
      )}
    </Space>
  );
}
