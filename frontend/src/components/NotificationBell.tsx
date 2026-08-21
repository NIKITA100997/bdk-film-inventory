import { useState } from "react";
import { Badge, Button, Popover, List, Typography, Space, Tag } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listNotifications, markNotificationRead } from "../api/notifications";
import { useAuth } from "../auth/AuthContext";

const REFRESH_MS = 5 * 60 * 1000;

/** Центр уведомлений (раздел 16 бэклога доработок — персистентная история)
 * — переиспользует сигнал "давно не двигалось" (тот же, что и на "Обзоре"),
 * но теперь через персистентную таблицу notifications: сверка живых
 * сигналов с сохранённой историей происходит на бэкенде при каждом опросе
 * (см. api/notifications.py), не в компоненте. Бейдж считает непрочитанные
 * (read_at == null), не просто "сколько сейчас плохо" — в этом и смысл
 * фичи. Гейт — reports.view (совпадает с правом самого эндпоинта и с тем,
 * как этот же сигнал гейтится на "Обзоре"; раньше здесь ошибочно стояло
 * inventory.manage — несоответствие с require_permission на бэкенде). */
export default function NotificationBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const has = (permission: string) => !!user?.is_superuser || !!user?.permissions.includes(permission);
  const showNotifications = has("reports.view");
  const [open, setOpen] = useState(false);

  const notificationsQuery = useQuery({
    queryKey: ["notifications"],
    queryFn: listNotifications,
    enabled: showNotifications,
    refetchInterval: REFRESH_MS,
  });

  const readMutation = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  if (!showNotifications) return null;

  const notifications = notificationsQuery.data ?? [];
  const unreadCount = notifications.filter((n) => !n.read_at).length;

  const goTo = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const content = (
    <Space direction="vertical" size="middle" style={{ width: 340, maxHeight: 420, overflowY: "auto" }}>
      <div>
        <Typography.Text strong>Давно не двигалось ({notifications.length})</Typography.Text>
        {notifications.length === 0 ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 4 }}>
            Нет сигналов
          </Typography.Paragraph>
        ) : (
          <List
            size="small"
            dataSource={notifications.slice(0, 8)}
            renderItem={(n) => (
              <List.Item
                style={{ cursor: n.read_at ? "default" : "pointer" }}
                onClick={() => !n.read_at && readMutation.mutate(n.id)}
              >
                <Space direction="vertical" size={0} style={{ width: "100%" }}>
                  <Space>
                    {!n.read_at && <Tag color="blue">новое</Tag>}
                    <Typography.Text strong={!n.read_at}>{n.title}</Typography.Text>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {n.detail}
                  </Typography.Text>
                </Space>
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
      <Badge count={unreadCount} size="small">
        <Button icon={<BellOutlined />} />
      </Badge>
    </Popover>
  );
}
