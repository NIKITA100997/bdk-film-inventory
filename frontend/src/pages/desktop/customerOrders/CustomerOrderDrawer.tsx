import {
  Drawer,
  Space,
  Typography,
  Tag,
  Progress,
  Button,
  Descriptions,
  Table,
  Spin,
  Alert,
} from "antd";
import { ExportOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import {
  getCustomerOrder,
  STAGE_COLOR,
  type CustomerOrderLine,
} from "../../../api/customerOrders";
import { PRIORITY_COLOR, PRIORITY_LABEL } from "../../../api/productionOrders";
import OrderTimelineCard from "./OrderTimelineCard";

interface Props {
  orderId: number | null;
  open: boolean;
  onClose: () => void;
}

export default function CustomerOrderDrawer({ orderId, open, onClose }: Props) {
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ["customer-order", orderId],
    queryFn: () => getCustomerOrder(orderId!),
    enabled: open && orderId !== null,
  });

  const order = query.data;

  return (
    <Drawer
      title={
        order ? (
          <Space align="center" wrap style={{ maxWidth: "100%" }}>
            <Typography.Text strong style={{ fontSize: 16 }}>
              Счёт №{order.invoice_no}
            </Typography.Text>
            {order.invoice_date && (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                от {dayjs(order.invoice_date).format("DD.MM.YYYY")}
              </Typography.Text>
            )}
            <Tag color={STAGE_COLOR[order.stage]}>{order.stage_label}</Tag>
            {order.priority > 0 && (
              <Tag color={PRIORITY_COLOR[order.priority]}>
                {PRIORITY_LABEL[order.priority]}
              </Tag>
            )}
          </Space>
        ) : (
          "Заказ покупателя"
        )
      }
      extra={
        orderId ? (
          <Button
            type="primary"
            icon={<ExportOutlined />}
            onClick={() => {
              onClose();
              navigate(`/customer-orders/${orderId}`);
            }}
          >
            Вся страница ↗
          </Button>
        ) : null
      }
      placement="right"
      size={Math.min(760, typeof window !== "undefined" ? window.innerWidth - 24 : 760)}
      open={open}
      onClose={onClose}
      styles={{ body: { padding: 16 } }}
    >
      {query.isLoading ? (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <Spin size="large" />
        </div>
      ) : query.isError || !order ? (
        <Alert
          type="error"
          message="Не удалось загрузить данные заказа"
          description={String(query.error || "Заказ не найден")}
        />
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {/* Сводные данные */}
          <Descriptions
            bordered
            size="small"
            column={{ xs: 1, sm: 2, md: 3 }}
            style={{ backgroundColor: "#fafafa" }}
          >
            <Descriptions.Item label="Клиент">
              <b>{order.customer || "Не указан"}</b>
            </Descriptions.Item>
            <Descriptions.Item label="Менеджер">
              {order.manager_name || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Сумма счёта">
              {order.amount_rub ? `${order.amount_rub.toLocaleString()} ₽` : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Вилка отгрузки">
              {order.ship_from || order.ship_to
                ? `${order.ship_from ? dayjs(order.ship_from).format("DD.MM") : "—"} — ${order.ship_to ? dayjs(order.ship_to).format("DD.MM.YY") : "—"}`
                : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="План готовности">
              {order.promised_ready ? (
                <b>{dayjs(order.promised_ready).format("DD.MM.YYYY")}</b>
              ) : (
                "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="План отгрузки">
              {order.ship_date ? (
                <b>{dayjs(order.ship_date).format("DD.MM.YYYY")}</b>
              ) : (
                "—"
              )}
            </Descriptions.Item>
          </Descriptions>

          {/* Прогресс выполнения */}
          <div
            style={{
              padding: "12px 16px",
              background: "#fff",
              border: "1px solid #f0f0f0",
              borderRadius: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
                fontSize: 13,
              }}
            >
              <span>
                Готовность: <b>{order.received}</b> из <b>{order.qty} шт</b>
                {order.shipped > 0 && ` (отгружено: ${order.shipped} шт)`}
              </span>
              <span style={{ fontWeight: 600, color: "#1677ff" }}>
                {order.qty ? Math.round((order.received / order.qty) * 100) : 0}%
              </span>
            </div>
            <Progress
              percent={order.qty ? Math.round((order.received / order.qty) * 100) : 0}
              success={{
                percent: order.qty ? Math.round((order.shipped / order.qty) * 100) : 0,
              }}
              strokeColor="#52c41a"
            />
          </div>

          {/* Интерактивный сквозной таймлайн заказа */}
          <div>
            <Typography.Text strong style={{ fontSize: 14 }}>
              Сквозной статус выполнения
            </Typography.Text>
            <div style={{ marginTop: 8 }}>
              <OrderTimelineCard orderId={order.id} />
            </div>
          </div>

          {/* Связка с Bitrix24 */}
          {order.bitrix_deal_id && (
            <Alert
              type="info"
              showIcon
              message={
                <Space>
                  <span>Сделка CRM Bitrix24:</span>
                  <a
                    href={order.bitrix_deal_url || undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <b>#{order.bitrix_deal_id}</b> ↗
                  </a>
                </Space>
              }
              style={{ fontSize: 13 }}
            />
          )}

          {/* Позиции заказа */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <Typography.Text strong style={{ fontSize: 14 }}>
                Состав позиций ({order.lines.length})
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Всего: {order.qty} шт
              </Typography.Text>
            </div>
            <Table<CustomerOrderLine>
              dataSource={order.lines}
              rowKey="id"
              size="small"
              pagination={false}
              bordered
              columns={[
                {
                  title: "Наименование",
                  dataIndex: "item_name",
                  render: (text, record) => (
                    <div>
                      <div style={{ fontWeight: 500 }}>{text}</div>
                      {record.note && (
                        <div style={{ fontSize: 11, color: "#8c8c8c" }}>{record.note}</div>
                      )}
                      {record.options && record.options.length > 0 && (
                        <div style={{ fontSize: 11, color: "#1677ff", marginTop: 2 }}>
                          {record.options.map((o) => `${o.name}: ${o.value}`).join(" · ")}
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  title: "Кол-во",
                  dataIndex: "quantity",
                  width: 80,
                  align: "right",
                  render: (q) => <b>{q}</b>,
                },
                {
                  title: "В плане",
                  dataIndex: "launched",
                  width: 80,
                  align: "right",
                  render: (l) => (
                    <span style={{ color: l > 0 ? "#1677ff" : "#8c8c8c" }}>{l}</span>
                  ),
                },
                {
                  title: "Готово",
                  dataIndex: "received",
                  width: 80,
                  align: "right",
                  render: (r, record) => (
                    <span
                      style={{
                        color:
                          (r ?? 0) >= record.quantity
                            ? "#52c41a"
                            : (r ?? 0) > 0
                              ? "#fa8c16"
                              : "#8c8c8c",
                        fontWeight: (r ?? 0) > 0 ? 600 : 400,
                      }}
                    >
                      {r ?? 0}
                    </span>
                  ),
                },
              ]}
            />
          </div>

          {/* Связанные заказы на производство */}
          {order.production_orders.length > 0 && (
            <div>
              <Typography.Text strong style={{ fontSize: 14 }}>
                Связанные заказы на производство:
              </Typography.Text>
              <Space wrap style={{ marginTop: 6 }}>
                {order.production_orders.map((po) => (
                  <Tag
                    key={po.id}
                    color="blue"
                    style={{ cursor: "pointer", padding: "4px 8px" }}
                    onClick={() => {
                      onClose();
                      navigate(`/production-orders/${po.id}`);
                    }}
                  >
                    Заказ цеха №{po.id} ({po.name}) ↗
                  </Tag>
                ))}
              </Space>
            </div>
          )}
        </Space>
      )}
    </Drawer>
  );
}
