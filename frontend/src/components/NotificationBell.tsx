import { useState } from "react";
import { Badge, Button, Popover, List, Typography, Space } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getStaleUnits } from "../api/reports";
import { useAuth } from "../auth/AuthContext";

const REFRESH_MS = 5 * 60 * 1000;

/** Центр уведомлений (раздел про ускорение работы) — переиспользует уже
 * существующий вычисляемый сигнал, который раньше был виден только на
 * "Обзоре" (Overview.tsx): давно не двигавшиеся остатки. Без новой
 * персистентной таблицы событий — та задача крупнее (read/unread, история)
 * и отложена в бэклог. Нехватки по заказам убраны вместе с самим экраном
 * "Заказы покупателей" — сигнал о нехватке теперь на "Выдаче участку", в
 * моменте, когда он реально нужен, не в общем списке. */
export default function NotificationBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const has = (permission: string) => !!user?.is_superuser || !!user?.permissions.includes(permission);
  const showStale = has("inventory.manage");
  const [open, setOpen] = useState(false);

  const staleQuery = useQuery({
    queryKey: ["stale-units", "bell"],
    queryFn: () => getStaleUnits(),
    enabled: showStale,
    refetchInterval: REFRESH_MS,
  });

  if (!showStale) return null;

  const stale = staleQuery.data ?? [];
  const total = stale.length;

  const goTo = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const content = (
    <Space direction="vertical" size="middle" style={{ width: 320, maxHeight: 420, overflowY: "auto" }}>
      <div>
        <Typography.Text strong>Давно не двигалось ({stale.length})</Typography.Text>
        {stale.length === 0 ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 4 }}>
            Нет сигналов
          </Typography.Paragraph>
        ) : (
          <List
            size="small"
            dataSource={stale.slice(0, 5)}
            renderItem={(u) => (
              <List.Item>
                <Typography.Text>
                  №{u.unit_id} — {u.material}, {u.color} — {u.days_idle} дн.
                </Typography.Text>
              </List.Item>
            )}
          />
        )}
        <Typography.Link onClick={() => goTo("/reports")}>Все →</Typography.Link>
      </div>
    </Space>
  );

  return (
    <Popover
      content={content}
      title="Что требует внимания"
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
    >
      <Badge count={total} size="small">
        <Button icon={<BellOutlined />} />
      </Badge>
    </Popover>
  );
}
