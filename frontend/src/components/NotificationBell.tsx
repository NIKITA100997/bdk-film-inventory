import { useState } from "react";
import { Badge, Button, Popover, List, Typography, Space } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listShortages } from "../api/orders";
import { getStaleUnits } from "../api/reports";
import { useAuth } from "../auth/AuthContext";

const REFRESH_MS = 5 * 60 * 1000;

/** Центр уведомлений (раздел про ускорение работы) — переиспользует уже
 * существующие вычисляемые сигналы, которые раньше были видны только на
 * "Обзоре" (Overview.tsx): нехватки по заказам и давно не двигавшиеся
 * остатки. Без новой персистентной таблицы событий — та задача крупнее
 * (read/unread, история) и отложена в бэклог. Гейты источников совпадают
 * с одноимёнными виджетами на "Обзоре", чтобы не показывать то, что
 * пользователь не может открыть по ссылке. */
export default function NotificationBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const has = (permission: string) => !!user?.is_superuser || !!user?.permissions.includes(permission);
  const showShortages = has("reports.view");
  const showStale = has("inventory.manage");
  const [open, setOpen] = useState(false);

  const shortagesQuery = useQuery({
    queryKey: ["orders-shortages", "bell"],
    queryFn: listShortages,
    enabled: showShortages,
    refetchInterval: REFRESH_MS,
  });
  const staleQuery = useQuery({
    queryKey: ["stale-units", "bell"],
    queryFn: () => getStaleUnits(),
    enabled: showStale,
    refetchInterval: REFRESH_MS,
  });

  if (!showShortages && !showStale) return null;

  const shortages = shortagesQuery.data ?? [];
  const stale = staleQuery.data ?? [];
  const total = shortages.length + stale.length;

  const goTo = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const content = (
    <Space direction="vertical" size="middle" style={{ width: 320, maxHeight: 420, overflowY: "auto" }}>
      {showShortages && (
        <div>
          <Typography.Text strong>Нехватки по заказам ({shortages.length})</Typography.Text>
          {shortages.length === 0 ? (
            <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 4 }}>
              Нет нехваток
            </Typography.Paragraph>
          ) : (
            <List
              size="small"
              dataSource={shortages.slice(0, 5)}
              renderItem={(s) => (
                <List.Item>
                  <Typography.Text>
                    Заказ №{s.order_number} — {s.material}, {s.color}, {s.thickness} мм
                  </Typography.Text>
                </List.Item>
              )}
            />
          )}
          <Typography.Link onClick={() => goTo("/purchasing")}>Все →</Typography.Link>
        </div>
      )}
      {showStale && (
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
      )}
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
