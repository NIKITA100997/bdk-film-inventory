import { useState } from "react";
import { Button, Card, Col, Modal, Progress, Row, Space, Spin, Tag, Tooltip, Typography, message } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { CopyOutlined, CheckCircleOutlined, SyncOutlined, ClockCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { getCustomerOrderTimeline, type TimelineStage } from "../../../api/customerOrders";
import { apiErrorMessage } from "../../../utils/apiError";

const STAGE_ICONS: Record<string, string> = {
  invoice: "📑",
  materials: "📦",
  parts: "🪵",
  processing: "⚙️",
  assembly: "🔨",
  warehouse: "🏢",
  shipment: "🚚",
};

interface Props {
  orderId: number;
}

export default function OrderTimelineCard({ orderId }: Props) {
  const [copied, setCopied] = useState(false);
  const q = useQuery({
    queryKey: ["customer-order-timeline", orderId],
    queryFn: () => getCustomerOrderTimeline(orderId),
    enabled: orderId > 0,
    refetchInterval: 30000,
  });

  if (q.isLoading) {
    return (
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space style={{ display: "flex", justifyContent: "center", padding: 16 }}>
          <Spin size="small" />
          <Typography.Text type="secondary">Загрузка таймлайна заказа…</Typography.Text>
        </Space>
      </Card>
    );
  }

  if (q.isError || !q.data) {
    return null;
  }

  const tl = q.data;

  const copyStatus = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(tl.client_message);
      } else {
        // Fallback for older browsers
        const area = document.createElement("textarea");
        area.value = tl.client_message;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopied(true);
      message.success("Статус скопирован! Готов для отправки в Telegram или WhatsApp");
      setTimeout(() => setCopied(false), 3000);
    } catch (e) {
      message.error(apiErrorMessage(e, "Не удалось скопировать статус"));
    }
  };

  const statusColor =
    tl.delay_days > 0 ? "orange" : tl.received >= tl.qty && tl.qty > 0 ? "green" : "blue";

  return (
    <Card
      size="small"
      style={{
        marginBottom: 16,
        background: "linear-gradient(180deg, #fbfcfd 0%, #ffffff 100%)",
        border: "1px solid #d9e1e8",
        borderRadius: 8,
      }}
      title={
        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap size={8}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>⏱️ Сквозной таймлайн заказа</span>
            <Tag color={statusColor} style={{ fontSize: 13, padding: "2px 8px" }}>
              {tl.status_summary}
            </Tag>
            {tl.delay_days > 0 && (
              <Tag color="red" icon={<WarningOutlined />}>
                Отставание {tl.delay_days} дн.
              </Tag>
            )}
          </Space>
          <Button
            type="primary"
            icon={<CopyOutlined />}
            size="small"
            style={{
              background: copied ? "#52c41a" : "#2d5a88",
              borderColor: copied ? "#52c41a" : "#2d5a88",
            }}
            onClick={copyStatus}
          >
            {copied ? "Скопировано!" : "Скопировать статус клиенту"}
          </Button>
        </Space>
      }
    >
      {/* Overall Progress Bar */}
      <div style={{ marginBottom: 16 }}>
        <Row justify="space-between" align="middle" style={{ marginBottom: 4 }}>
          <Col>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ОБЩАЯ ГОТОВНОСТЬ ЗАКАЗА (на складе {tl.received} из {tl.qty} шт)
            </Typography.Text>
          </Col>
          <Col>
            <Typography.Text strong style={{ fontSize: 13 }}>
              {tl.overall_progress_pct}%
            </Typography.Text>
          </Col>
        </Row>
        <Progress
          percent={tl.overall_progress_pct}
          status={tl.delay_days > 0 ? "exception" : tl.overall_progress_pct >= 100 ? "success" : "active"}
          strokeColor={
            tl.delay_days > 0
              ? { "0%": "#fa8c16", "100%": "#f5222d" }
              : { "0%": "#2d5a88", "100%": "#52c41a" }
          }
          style={{ marginBottom: 0 }}
        />
      </div>

      {/* 7-Stage Pipeline */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: 8,
          marginTop: 8,
        }}
      >
        {tl.stages.map((stage: TimelineStage, idx: number) => {
          const isDone = stage.status === "completed" || stage.progress_pct >= 100;
          const isInProgress = stage.status === "in_progress" || (stage.progress_pct > 0 && !isDone);
          const isBottleneck = stage.is_bottleneck;

          const borderColor = isBottleneck
            ? "#ff4d4f"
            : isDone
              ? "#b7eb8f"
              : isInProgress
                ? "#91caff"
                : "#f0f0f0";
          const bgColor = isBottleneck
            ? "#fff1f0"
            : isDone
              ? "#f6ffed"
              : isInProgress
                ? "#e6f4ff"
                : "#fafafa";

          return (
            <div
              key={stage.key}
              style={{
                border: `1px solid ${borderColor}`,
                borderRadius: 6,
                padding: "8px 10px",
                backgroundColor: bgColor,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                minHeight: 100,
                position: "relative",
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 16 }}>{STAGE_ICONS[stage.key] ?? "▫️"}</span>
                  {isDone ? (
                    <CheckCircleOutlined style={{ color: "#52c41a" }} />
                  ) : isInProgress ? (
                    <SyncOutlined spin style={{ color: "#1677ff" }} />
                  ) : (
                    <ClockCircleOutlined style={{ color: "#8c8c8c" }} />
                  )}
                </div>
                <Typography.Text
                  strong
                  style={{
                    fontSize: 12,
                    display: "block",
                    lineHeight: "14px",
                    color: isBottleneck ? "#cf1322" : "inherit",
                  }}
                >
                  {idx + 1}. {stage.name}
                </Typography.Text>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, display: "block", marginTop: 4, lineHeight: "13px" }}
                >
                  {stage.description}
                </Typography.Text>
              </div>

              <div style={{ marginTop: 6 }}>
                <Progress
                  percent={stage.progress_pct}
                  size="small"
                  showInfo={false}
                  strokeColor={isBottleneck ? "#f5222d" : isDone ? "#52c41a" : "#1677ff"}
                />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                    {stage.progress_pct}%
                  </Typography.Text>
                  {stage.qty_total > 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                      {stage.qty_done}/{stage.qty_total}
                    </Typography.Text>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Timing Delta & Bottleneck Notice */}
      <div
        style={{
          marginTop: 12,
          padding: "6px 12px",
          background: "#f0f5fa",
          borderRadius: 4,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          fontSize: 12,
        }}
      >
        <Space size={16} wrap>
          <span>
            <b>Обещанная готовность:</b>{" "}
            {tl.promised_ready ? dayjs(tl.promised_ready).format("DD.MM.YYYY") : "не задана"}
          </span>
          <span>
            <b>Обещанная отгрузка:</b>{" "}
            {tl.ship_date ? dayjs(tl.ship_date).format("DD.MM.YYYY") : "не согласована"}
          </span>
          {tl.plan_finish && (
            <span>
              <b>Расчёт по графику:</b> {dayjs(tl.plan_finish).format("DD.MM.YYYY")}
            </span>
          )}
        </Space>
        <div>
          <Tooltip title="Нажмите, чтобы скопировать готовое сообщение для клиента в мессенджер">
            <Typography.Link onClick={copyStatus}>
              📋 Текст для мессенджера (предпросмотр)
            </Typography.Link>
          </Tooltip>
        </div>
      </div>
    </Card>
  );
}

/** Модальное окно таймлайна для вызова из таблиц. */
export function OrderTimelineModal({
  orderId,
  open,
  onClose,
}: {
  orderId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!orderId) return null;
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      title="Сквозной таймлайн заказа"
      destroyOnClose
    >
      <OrderTimelineCard orderId={orderId} />
    </Modal>
  );
}
