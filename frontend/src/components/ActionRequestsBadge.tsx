import { Badge, Button, Tooltip } from "antd";
import { AuditOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { actionRequestsSummary } from "../api/control";

/** Значок «Запросы» в шапке (07.10): тем, кто подтверждает, — сколько ждут
 * решения; остальным — сколько их запросов уже решено и не просмотрено. */
export default function ActionRequestsBadge() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["action-requests-summary"], queryFn: actionRequestsSummary, refetchInterval: 60_000 });
  const s = q.data;
  const count = (s?.to_approve ?? 0) + (s?.mine_resolved ?? 0);
  const tip = s?.can_approve
    ? `Запросы сотрудников: ждут решения — ${s.to_approve}`
    : `Мои запросы администратору${s?.mine_resolved ? `: решено — ${s.mine_resolved}` : ""}`;
  return (
    <Tooltip title={tip}>
      <Badge count={count} size="small" offset={[-4, 4]}>
        <Button
          type="text"
          aria-label="Запросы администратору"
          icon={<AuditOutlined style={{ color: "#fff" }} />}
          onClick={() => navigate(s?.can_approve && s.to_approve ? "/action-requests?tab=pending" : "/action-requests")}
        />
      </Badge>
    </Tooltip>
  );
}
