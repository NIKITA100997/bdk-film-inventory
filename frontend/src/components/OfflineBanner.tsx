import { useState } from "react";
import { Alert, Button, Space, Drawer, List, Typography, Popconfirm } from "antd";
import { SyncOutlined, DeleteOutlined, CheckCircleOutlined, WifiOutlined } from "@ant-design/icons";
import { useMutationState } from "@tanstack/react-query";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { useOfflineQueue, removeOfflineAction, type QueuedOfflineAction } from "../services/offlineQueue";
import UiBadge from "./UiBadge";

/**
 * Расширенный промышленный Offline-баннер и центр синхронизации:
 * - Отслеживает сетевые паузы TanStack Query;
 * - Хранит сохранённые в localStorage отчёты мастеров (даже при перезагрузке планшета);
 * - Автоматически отправляет накопленные отчёты по FIFO при появлении Wi-Fi в цеху;
 * - Даёт оператору ручной контроль над очередью через удобный Drawer.
 */
export default function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const { queue, queueCount, isSyncing, syncNow, clearAll } = useOfflineQueue();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const pausedCount = useMutationState({
    filters: { status: "pending" },
    select: (mutation) => mutation.state,
  }).filter((m) => m.isPaused).length;

  const totalPending = pausedCount + queueCount;

  if (isOnline && totalPending === 0) return null;

  return (
    <>
      <div style={{ position: "sticky", top: 0, zIndex: 1040, width: "100%" }}>
        {!isOnline ? (
          <Alert
            type="warning"
            showIcon={false}
            banner
            message={
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <Space>
                  <span style={{ fontSize: 16 }}>⚡</span>
                  <b>Режим офлайн (нет связи с сервером)</b>
                  {totalPending > 0 && <UiBadge color="orange">В памяти: {totalPending}</UiBadge>}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Данные сохраняются в памяти планшета и отправятся автоматически при появлении связи.
                  </Typography.Text>
                </Space>
                {queueCount > 0 && (
                  <Button size="small" onClick={() => setDrawerOpen(true)}>
                    Очередь ({queueCount})
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <Alert
            type="info"
            showIcon={false}
            banner
            message={
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <Space>
                  <WifiOutlined style={{ color: "#52c41a" }} />
                  <span>
                    Связь восстановлена — передаём отложенные действия: <b>{totalPending}</b>…
                  </span>
                </Space>
                <Space size="small">
                  {queueCount > 0 && (
                    <>
                      <Button
                        type="primary"
                        size="small"
                        icon={<SyncOutlined spin={isSyncing} />}
                        loading={isSyncing}
                        onClick={syncNow}
                      >
                        Синхронизировать
                      </Button>
                      <Button size="small" onClick={() => setDrawerOpen(true)}>
                        Очередь ({queueCount})
                      </Button>
                    </>
                  )}
                </Space>
              </div>
            }
          />
        )}
      </div>

      <Drawer
        title={
          <Space>
            <span>Офлайн-буфер отчётов цеха</span>
            <UiBadge color="blue">{queueCount}</UiBadge>
          </Space>
        }
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={440}
        extra={
          queueCount > 0 && (
            <Space>
              <Button
                type="primary"
                size="small"
                icon={<SyncOutlined spin={isSyncing} />}
                loading={isSyncing}
                onClick={syncNow}
                disabled={!isOnline}
              >
                Отправить все
              </Button>
              <Popconfirm
                title="Очистить очередь?"
                description="Неотправленные отчёты будут удалены из памяти устройства безвозвратно."
                onConfirm={clearAll}
                okText="Очистить"
                cancelText="Отмена"
              >
                <Button size="small" danger icon={<DeleteOutlined />}>
                  Очистить
                </Button>
              </Popconfirm>
            </Space>
          )
        }
      >
        {queue.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 0", color: "#888" }}>
            <CheckCircleOutlined style={{ fontSize: 36, color: "#52c41a", marginBottom: 12 }} />
            <div>Все отчёты успешно переданы на сервер</div>
          </div>
        ) : (
          <List
            dataSource={queue}
            renderItem={(item: QueuedOfflineAction) => (
              <List.Item
                actions={[
                  <Button
                    key="del"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeOfflineAction(item.id)}
                    title="Удалить из очереди"
                  />,
                ]}
              >
                <List.Item.Meta
                  title={item.title}
                  description={
                    <Space direction="vertical" size={2} style={{ fontSize: 11 }}>
                      <div>Время сохранения: {new Date(item.createdAt).toLocaleTimeString()}</div>
                      <div>Эндпоинт: <code>{item.endpoint}</code></div>
                      {item.retryCount > 0 && (
                        <div style={{ color: "#d46b08" }}>
                          Попыток отправки: {item.retryCount} {item.lastError ? `(${item.lastError})` : ""}
                        </div>
                      )}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </>
  );
}
