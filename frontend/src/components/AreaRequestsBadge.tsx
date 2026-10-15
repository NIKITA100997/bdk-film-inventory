import { Badge, Button, Tooltip } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { hasPerm } from "../auth/permissions";
import { getAreaRequestsSummary } from "../api/areaSupply";

/** Значок «Заявки участков» в шапке (15.10) — складу и начальнику цеха:
 * сколько новых заявок ждут, пока их возьмут в работу. Нет заявок — нет значка. */
export default function AreaRequestsBadge() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const handles = hasPerm(user, "units.issue", "production_tasks.manage");
  const q = useQuery({ queryKey: ["area-requests-summary"], queryFn: getAreaRequestsSummary, refetchInterval: 60_000, enabled: handles });
  if (!handles || !q.data?.open) return null;
  return (
    <Tooltip title={`Заявки участков: новых ${q.data.new}, всего открыто ${q.data.open}`}>
      <Badge count={q.data.new} size="small" offset={[-4, 4]}>
        <Button type="text" aria-label="Заявки участков" icon={<InboxOutlined style={{ color: "#fff" }} />} onClick={() => navigate("/area-supply")} />
      </Badge>
    </Tooltip>
  );
}
