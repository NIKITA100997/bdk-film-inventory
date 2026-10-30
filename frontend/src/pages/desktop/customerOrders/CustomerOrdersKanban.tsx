import { useMemo } from "react";
import { Badge, Card, Progress, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { STAGE_COLOR, type CustomerOrder } from "../../../api/customerOrders";
import { PRIORITY_COLOR, PRIORITY_LABEL } from "../../../api/productionOrders";

interface CustomerOrdersKanbanProps {
  orders: CustomerOrder[];
  onSelect: (orderId: number) => void;
}

interface KanbanColumn {
  key: string;
  title: string;
  icon: string;
  accentColor: string;
  match: (o: CustomerOrder) => boolean;
}

const KANBAN_COLUMNS: KanbanColumn[] = [
  {
    key: "wait",
    title: "Ждут приёма",
    icon: "📥",
    accentColor: "#D48806",
    match: (o) => o.status === "submitted" || o.status === "draft",
  },
  {
    key: "accepted",
    title: "Согласованы (без запуска)",
    icon: "📋",
    accentColor: "#13C2C2",
    match: (o) => o.status === "accepted" && (o.stage === "accepted" || o.stage === "returned"),
  },
  {
    key: "production",
    title: "В производстве",
    icon: "🏭",
    accentColor: "#1677FF",
    match: (o) => o.stage === "in_production" || o.stage === "assembled",
  },
  {
    key: "ready",
    title: "Готовы / Склад ГП",
    icon: "📦",
    accentColor: "#52C41A",
    match: (o) => o.stage === "ready" || o.stage === "shipped_part",
  },
  {
    key: "shipped",
    title: "Отгружены / Закрыты",
    icon: "🚚",
    accentColor: "#8C8C8C",
    match: (o) => o.stage === "shipped" || o.status === "cancelled",
  },
];

export default function CustomerOrdersKanban({ orders, onSelect }: CustomerOrdersKanbanProps) {
  const groupedOrders = useMemo(() => {
    const map = new Map<string, CustomerOrder[]>();
    for (const col of KANBAN_COLUMNS) {
      map.set(col.key, []);
    }
    for (const order of orders) {
      const col = KANBAN_COLUMNS.find((c) => c.match(order)) ?? KANBAN_COLUMNS[0];
      map.get(col.key)!.push(order);
    }
    return map;
  }, [orders]);

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        overflowX: "auto",
        paddingBottom: 12,
        minHeight: 520,
        alignItems: "stretch",
      }}
    >
      {KANBAN_COLUMNS.map((col) => {
        const colOrders = groupedOrders.get(col.key) ?? [];
        const totalQty = colOrders.reduce((sum, o) => sum + (o.qty || 0), 0);

        return (
          <div
            key={col.key}
            style={{
              flex: "0 0 280px",
              minWidth: 260,
              maxWidth: 320,
              display: "flex",
              flexDirection: "column",
              background: "#F7F6F3",
              borderRadius: 8,
              border: "1px solid #EAE8E2",
              padding: 10,
            }}
          >
            {/* Заголовок колонки */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
                paddingBottom: 8,
                borderBottom: `2px solid ${col.accentColor}`,
              }}
            >
              <Space size={6} align="center">
                <span>{col.icon}</span>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {col.title}
                </Typography.Text>
              </Space>
              <Space size={4}>
                <Badge
                  count={colOrders.length}
                  style={{
                    backgroundColor: col.accentColor,
                    fontSize: 11,
                  }}
                />
                {totalQty > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {totalQty} шт
                  </Typography.Text>
                )}
              </Space>
            </div>

            {/* Карточки заказов */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                flex: "1 1 auto",
                overflowY: "auto",
                maxHeight: "calc(100vh - 280px)",
                paddingRight: 2,
              }}
            >
              {colOrders.length === 0 ? (
                <div
                  style={{
                    padding: "24px 8px",
                    textAlign: "center",
                    color: "#9E9E99",
                    fontSize: 12,
                  }}
                >
                  Нет заказов
                </div>
              ) : (
                colOrders.map((o) => {
                  const percent =
                    o.qty > 0
                      ? Math.min(100, Math.round(((o.received + o.shipped) / o.qty) * 100))
                      : 0;

                  return (
                    <Card
                      key={o.id}
                      size="small"
                      hoverable
                      onClick={() => onSelect(o.id)}
                      style={{
                        borderRadius: 6,
                        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                        cursor: "pointer",
                      }}
                      styles={{ body: { padding: 10 } }}
                    >
                      {/* Верх карточки: Номер, дата, приоритет */}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                          marginBottom: 4,
                        }}
                      >
                        <Space size={4} wrap>
                          <Typography.Text strong style={{ fontSize: 13 }}>
                            № {o.invoice_no}
                          </Typography.Text>
                          {o.invoice_date && (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              от {dayjs(o.invoice_date).format("DD.MM")}
                            </Typography.Text>
                          )}
                        </Space>
                        {o.priority > 0 && (
                          <Tag
                            color={PRIORITY_COLOR[o.priority]}
                            style={{ margin: 0, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}
                          >
                            {PRIORITY_LABEL[o.priority]}
                          </Tag>
                        )}
                      </div>

                      {/* Клиент */}
                      <Typography.Text
                        ellipsis={{ tooltip: o.customer ?? undefined }}
                        style={{ fontSize: 12, color: "#4A4A45", display: "block", marginBottom: 6 }}
                      >
                        {o.customer ? `👤 ${o.customer}` : "—"}
                      </Typography.Text>

                      {/* Состав строк */}
                      <div
                        style={{
                          fontSize: 11,
                          color: "#7A7A75",
                          marginBottom: 6,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {o.lines.length} поз., {o.qty} шт
                        {o.lines[0]?.item_name ? ` · ${o.lines[0].item_name}` : ""}
                      </div>

                      {/* Прогресс готовности */}
                      <div style={{ marginBottom: 6 }}>
                        <Progress
                          percent={percent}
                          size="small"
                          status={percent === 100 ? "success" : "active"}
                          format={() => `${percent}%`}
                        />
                      </div>

                      {/* Низ карточки: Статус и срок */}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: 11,
                        }}
                      >
                        <Tag
                          color={STAGE_COLOR[o.stage]}
                          style={{ margin: 0, fontSize: 10, padding: "0 4px", lineHeight: "16px" }}
                        >
                          {o.stage_label}
                        </Tag>

                        {o.ship_to ? (
                          <span
                            style={{
                              color: o.plan_late ? "#cf1322" : "#6B6B68",
                              fontWeight: o.plan_late ? 600 : 400,
                            }}
                          >
                            ⏳ {dayjs(o.ship_to).format("DD.MM")}
                          </span>
                        ) : null}
                      </div>
                    </Card>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
