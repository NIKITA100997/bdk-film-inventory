import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  REQUEST_STATUS,
  actionRequestsSummary,
  approveActionRequest,
  listActionRequests,
  rejectActionRequest,
  type ActionRequest,
} from "../api/control";
import { getInbox, type InboxItem } from "../api/inbox";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type Notification,
} from "../api/notifications";
import { useAuth } from "../auth/AuthContext";
import { apiErrorMessage } from "../utils/apiError";
import { fmtDateTime } from "../utils/dates";

interface ApprovalsDrawerProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: "approvals" | "inbox" | "signals";
}

export default function ApprovalsDrawer({ open, onClose, defaultTab = "approvals" }: ApprovalsDrawerProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"approvals" | "inbox" | "signals">(defaultTab);
  const [rejecting, setRejecting] = useState<ActionRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const has = (permission: string) => !!user?.is_superuser || !!user?.permissions.includes(permission);
  const showNotifications = has("reports.view");

  // 1. Action requests
  const summaryQuery = useQuery({
    queryKey: ["action-requests-summary"],
    queryFn: actionRequestsSummary,
    refetchInterval: 30_000,
  });
  const canApprove = !!summaryQuery.data?.can_approve;
  const toApproveCount = summaryQuery.data?.to_approve ?? 0;

  const pendingRequestsQuery = useQuery({
    queryKey: ["action-requests", "pending"],
    queryFn: () => listActionRequests("pending"),
    enabled: canApprove && open,
  });

  // 2. Inbox
  const inboxQuery = useQuery({
    queryKey: ["inbox"],
    queryFn: getInbox,
    refetchInterval: 60_000,
  });
  const inboxItems = inboxQuery.data ?? [];
  const urgentInbox = inboxItems.filter((i) => i.level === "urgent").length;

  // 3. Notifications signals
  const notificationsQuery = useQuery({
    queryKey: ["notifications"],
    queryFn: listNotifications,
    enabled: showNotifications,
    refetchInterval: 5 * 60 * 1000,
  });
  const notifications = notificationsQuery.data ?? [];
  const unreadSignals = notifications.filter((n) => !n.read_at).length;

  const refreshRequests = () => {
    qc.invalidateQueries({ queryKey: ["action-requests"] });
    qc.invalidateQueries({ queryKey: ["action-requests-summary"] });
  };

  const approveMutation = useMutation({
    mutationFn: (id: number) => approveActionRequest(id),
    onSuccess: (r) => {
      refreshRequests();
      if (r.status === "done") message.success("Действие успешно согласовано и проведено");
      else message.error(r.result ?? "Ошибка выполнения");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось согласовать")),
  });

  const rejectMutation = useMutation({
    mutationFn: () => rejectActionRequest(rejecting!.id, rejectReason.trim()),
    onSuccess: () => {
      refreshRequests();
      setRejecting(null);
      setRejectReason("");
      message.success("Запрос отклонён");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отклонить")),
  });

  const readMutation = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const readAllMutation = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const pendingRequests = pendingRequestsQuery.data ?? [];

  return (
    <>
      <Drawer
        title={
          <Space align="center" size={8}>
            <span style={{ fontSize: 18 }}>⚡</span>
            <span>Центр согласований и задач</span>
          </Space>
        }
        placement="right"
        width={460}
        open={open}
        onClose={onClose}
        styles={{ body: { padding: "12px 16px" } }}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {/* Переключатель вкладок внутри шторки */}
          <Segmented
            block
            value={activeTab}
            onChange={(v) => setActiveTab(v as "approvals" | "inbox" | "signals")}
            options={[
              ...(canApprove
                ? [
                    {
                      value: "approvals",
                      label: (
                        <Space size={4}>
                          <span>⚡ Согласования</span>
                          {toApproveCount > 0 && (
                            <Badge count={toApproveCount} style={{ backgroundColor: "#D4380D" }} />
                          )}
                        </Space>
                      ),
                    },
                  ]
                : []),
              {
                value: "inbox",
                label: (
                  <Space size={4}>
                    <span>📥 Ждёт меня</span>
                    {inboxItems.length > 0 && (
                      <Badge
                        count={urgentInbox || inboxItems.length}
                        style={{ backgroundColor: urgentInbox ? "#D4380D" : "#1677FF" }}
                      />
                    )}
                  </Space>
                ),
              },
              ...(showNotifications
                ? [
                    {
                      value: "signals",
                      label: (
                        <Space size={4}>
                          <span>🔔 Сигналы</span>
                          {unreadSignals > 0 && (
                            <Badge count={unreadSignals} style={{ backgroundColor: "#FA8C16" }} />
                          )}
                        </Space>
                      ),
                    },
                  ]
                : []),
            ]}
          />

          {/* Вкладка 1: Согласования запросов */}
          {activeTab === "approvals" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Запросы сотрудников на операции в закрытом периоде и действия без прямых прав
                </Typography.Text>
              </div>

              {pendingRequests.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Нет запросов, требующих решения"
                  style={{ margin: "40px 0" }}
                />
              ) : (
                pendingRequests.map((r) => (
                  <Card
                    key={r.id}
                    size="small"
                    style={{
                      borderRadius: 8,
                      border: "1px solid #EAE8E2",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                    }}
                    styles={{ body: { padding: 12 } }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <Space size={6} wrap>
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          № {r.id}
                        </Typography.Text>
                        <Tag color={r.kind === "period_closed" ? "red" : "orange"} style={{ margin: 0, fontSize: 10 }}>
                          {r.kind === "period_closed" ? "Закрытый период" : "Особые права"}
                        </Tag>
                        <Tag color={REQUEST_STATUS[r.status].color} style={{ margin: 0, fontSize: 10 }}>
                          {REQUEST_STATUS[r.status].label}
                        </Tag>
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {fmtDateTime(r.created_at)}
                      </Typography.Text>
                    </div>

                    <Typography.Paragraph
                      style={{
                        fontSize: 13,
                        margin: "6px 0",
                        background: "#FAF9F5",
                        padding: "6px 10px",
                        borderRadius: 4,
                        borderLeft: "3px solid #C97A2B",
                      }}
                    >
                      {r.comment || "Запрос на выполнение действия"}
                    </Typography.Paragraph>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        От: <b>{r.requested_by_name || "Сотрудник"}</b> · Экран: {r.page}
                      </Typography.Text>

                      <Space size={6}>
                        <Popconfirm
                          title="Согласовать действие?"
                          description="Действие будет проведено в системе от вашего имени."
                          okText="Да, согласовать"
                          cancelText="Отмена"
                          onConfirm={() => approveMutation.mutate(r.id)}
                        >
                          <Button
                            type="primary"
                            size="small"
                            icon={<CheckCircleOutlined />}
                            loading={approveMutation.isPending}
                          >
                            Согласовать
                          </Button>
                        </Popconfirm>
                        <Button
                          danger
                          size="small"
                          icon={<CloseCircleOutlined />}
                          onClick={() => {
                            setRejecting(r);
                            setRejectReason("");
                          }}
                        >
                          Отклонить
                        </Button>
                      </Space>
                    </div>
                  </Card>
                ))
              )}
            </div>
          )}

          {/* Вкладка 2: Ждёт меня */}
          {activeTab === "inbox" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {inboxItems.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Все текущие задачи выполнены"
                  style={{ margin: "40px 0" }}
                />
              ) : (
                <List
                  size="small"
                  dataSource={inboxItems}
                  renderItem={(it: InboxItem) => (
                    <List.Item
                      style={{
                        cursor: "pointer",
                        borderRadius: 6,
                        padding: "10px 12px",
                        marginBottom: 6,
                        background: "#fff",
                        border: "1px solid #EAE8E2",
                        transition: "all 0.2s",
                      }}
                      onClick={() => {
                        onClose();
                        navigate(it.link);
                      }}
                      actions={[<RightOutlined key="go" style={{ color: "#999", fontSize: 12 }} />]}
                    >
                      <Space orientation="vertical" size={2} style={{ width: "100%" }}>
                        <Space size={8} align="center">
                          <Badge
                            count={it.count}
                            overflowCount={999}
                            color={it.level === "urgent" ? "#D4380D" : "#1677FF"}
                          />
                          <Typography.Text strong={it.level === "urgent"} style={{ fontSize: 13 }}>
                            {it.title}
                          </Typography.Text>
                        </Space>
                        {it.hint && (
                          <Typography.Text type="secondary" style={{ fontSize: 11, paddingLeft: 18 }}>
                            {it.hint}
                          </Typography.Text>
                        )}
                      </Space>
                    </List.Item>
                  )}
                />
              )}
            </div>
          )}

          {/* Вкладка 3: Сигналы («Давно не двигалось») */}
          {activeTab === "signals" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Позиции и рулоны без движения
                </Typography.Text>
                {notifications.length > 0 && (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => readAllMutation.mutate()}
                    loading={readAllMutation.isPending}
                  >
                    Прочитать все
                  </Button>
                )}
              </div>

              {notifications.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Нет активных сигналов"
                  style={{ margin: "40px 0" }}
                />
              ) : (
                <List
                  size="small"
                  dataSource={notifications}
                  renderItem={(n: Notification) => (
                    <List.Item
                      style={{
                        padding: "10px 12px",
                        marginBottom: 6,
                        background: n.read_at ? "#FAFAFA" : "#fff",
                        borderRadius: 6,
                        border: "1px solid #EAE8E2",
                        opacity: n.read_at ? 0.75 : 1,
                      }}
                      actions={
                        !n.read_at
                          ? [
                              <Button
                                key="read"
                                size="small"
                                type="text"
                                onClick={() => readMutation.mutate(n.id)}
                              >
                                ✓
                              </Button>,
                            ]
                          : undefined
                      }
                    >
                      <Space orientation="vertical" size={2}>
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          {n.title}
                        </Typography.Text>
                        {n.detail && (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {n.detail}
                          </Typography.Text>
                        )}
                        <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                          {fmtDateTime(n.first_seen_at)}
                        </Typography.Text>
                      </Space>
                    </List.Item>
                  )}
                />
              )}
            </div>
          )}
        </Space>
      </Drawer>

      {/* Модальное окно отклонения запроса */}
      <Modal
        open={rejecting !== null}
        title="Отклонить запрос администратору"
        okText="Отклонить"
        okButtonProps={{ danger: true, disabled: !rejectReason.trim(), loading: rejectMutation.isPending }}
        cancelText="Отмена"
        onOk={() => rejectMutation.mutate()}
        onCancel={() => {
          setRejecting(null);
          setRejectReason("");
        }}
        destroyOnHidden
      >
        <Space orientation="vertical" size="small" style={{ width: "100%", marginTop: 8 }}>
          <Typography.Text>
            Укажите причину отклонения запроса №{rejecting?.id} (сотрудник увидит этот комментарий):
          </Typography.Text>
          <Input.TextArea
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Например: сначала согласуйте списание с начальником производства..."
            autoFocus
          />
        </Space>
      </Modal>
    </>
  );
}
