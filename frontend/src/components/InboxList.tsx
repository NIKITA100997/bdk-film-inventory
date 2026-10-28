import { Badge, Button, List, Popover, Space, Tooltip, Typography } from "antd";
import { CheckSquareOutlined, RightOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getInbox, type InboxItem } from "../api/inbox";

export const useInbox = () => useQuery({ queryKey: ["inbox"], queryFn: getInbox, refetchInterval: 60_000 });

/** Список «Ждёт меня» — на главной и во всплывающем окне значка в шапке. */
export function InboxList({ items, onOpen }: { items: InboxItem[]; onOpen?: () => void }) {
  const navigate = useNavigate();
  return (
    <List
      size="small"
      dataSource={items}
      locale={{ emptyText: "Ничего не ждёт" }}
      renderItem={(it) => (
        <List.Item
          style={{ cursor: "pointer" }}
          onClick={() => {
            onOpen?.();
            navigate(it.link);
          }}
          actions={[<RightOutlined key="go" style={{ color: "#999" }} />]}
        >
          <Space direction="vertical" size={0}>
            <Space size={8}>
              <Badge count={it.count} overflowCount={999} color={it.level === "urgent" ? "#d4380d" : "#8c8c8c"} />
              <Typography.Text strong={it.level === "urgent"}>{it.title}</Typography.Text>
            </Space>
            {it.hint && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {it.hint}
              </Typography.Text>
            )}
          </Space>
        </List.Item>
      )}
    />
  );
}

/** Значок «Ждёт меня» в шапке: сколько видов дел ждут; клик — список. */
export function InboxBadge() {
  const q = useInbox();
  const items = q.data ?? [];
  if (!items.length) return null;
  const urgent = items.filter((i) => i.level === "urgent").length;
  return (
    <Popover trigger="click" placement="bottomRight" title="Ждёт меня" content={<div style={{ width: 380 }}><InboxList items={items} /></div>}>
      <Tooltip title={`Ждёт меня: ${items.length}`}>
        <Badge count={urgent || items.length} color={urgent ? "#d4380d" : "#8c8c8c"} size="small" offset={[-4, 4]}>
          <Button type="text" aria-label="Ждёт меня" icon={<CheckSquareOutlined style={{ color: "#fff" }} />} />
        </Badge>
      </Tooltip>
    </Popover>
  );
}
