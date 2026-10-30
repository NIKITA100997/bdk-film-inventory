import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  Row,
  Col,
  Statistic,
  Progress,
  Tag,
  Alert,
  Button,
  Space,
  Typography,
  Spin,
  Tooltip,
} from "antd";
import {
  ThunderboltOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  ArrowRightOutlined,
  FireOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { getFactoryPulse, type FactoryPulse } from "../../api/home";

const { Text } = Typography;

export const DirectorPulse: React.FC = () => {
  const navigate = useNavigate();
  const { data: pulse, isLoading, isError, refetch, isFetching } = useQuery<FactoryPulse>({
    queryKey: ["factoryPulse"],
    queryFn: () => getFactoryPulse(),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div style={{ textAlign: "center", padding: 32 }}>
        <Spin tip="Загрузка пульса завода..." />
      </div>
    );
  }

  if (isError || !pulse) {
    return (
      <Alert
        type="error"
        message="Не удалось загрузить данные пульса завода"
        action={
          <Button size="small" onClick={() => refetch()}>
            Повторить
          </Button>
        }
      />
    );
  }

  const planStatus =
    pulse.plan_completion_pct >= 90
      ? "success"
      : pulse.plan_completion_pct >= 60
      ? "normal"
      : "exception";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Верхняя строка: 4 ключевых показателя смены */}
      <Row gutter={[12, 12]}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small" bordered style={{ borderRadius: 8, background: "#f6ffed", borderColor: "#b7eb8f" }}>
            <Statistic
              title={<span style={{ fontWeight: 600, color: "#389e0d" }}>Выпуск за смену</span>}
              value={pulse.output_pieces_today}
              suffix={<span style={{ fontSize: 14 }}>шт</span>}
              prefix={<ThunderboltOutlined style={{ color: "#52c41a" }} />}
              valueStyle={{ fontWeight: "bold", color: "#237804" }}
            />
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {pulse.output_rub_today > 0
                  ? `Оценка: ~${Math.round(pulse.output_rub_today).toLocaleString("ru-RU")} ₽`
                  : "По данным отчётов цеха и ГП"}
              </Text>
            </div>
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card size="small" bordered style={{ borderRadius: 8, background: "#e6f7ff", borderColor: "#91d5ff" }}>
            <Statistic
              title={<span style={{ fontWeight: 600, color: "#096dd9" }}>Исполнение плана</span>}
              value={pulse.plan_completion_pct}
              suffix="%"
              prefix={<CheckCircleOutlined style={{ color: "#1890ff" }} />}
              valueStyle={{ fontWeight: "bold", color: "#0050b3" }}
            />
            <div style={{ marginTop: 6 }}>
              <Progress
                percent={pulse.plan_completion_pct}
                status={planStatus}
                size="small"
                showInfo={false}
              />
              <Text type="secondary" style={{ fontSize: 11 }}>
                План на день: {Math.round(pulse.planned_pieces_today)} шт
              </Text>
            </div>
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card
            size="small"
            bordered
            style={{
              borderRadius: 8,
              background: pulse.defect_pct_today > 3 ? "#fff2e8" : "#fafafa",
              borderColor: pulse.defect_pct_today > 3 ? "#ffbb96" : "#d9d9d9",
            }}
          >
            <Statistic
              title={<span style={{ fontWeight: 600, color: "#d4380d" }}>Брак за смену</span>}
              value={pulse.defect_pct_today}
              precision={1}
              suffix="%"
              prefix={<WarningOutlined style={{ color: "#fa541c" }} />}
              valueStyle={{
                fontWeight: "bold",
                color: pulse.defect_pct_today > 3 ? "#cf1322" : "#595959",
              }}
            />
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Объём дефектов: {Math.round(pulse.defect_pieces_today)} шт
              </Text>
            </div>
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card
            size="small"
            bordered
            style={{
              borderRadius: 8,
              background: pulse.delayed_orders_count > 0 ? "#fff1f0" : "#fafafa",
              borderColor: pulse.delayed_orders_count > 0 ? "#ffa39e" : "#d9d9d9",
            }}
          >
            <Statistic
              title={<span style={{ fontWeight: 600, color: "#cf1322" }}>Срывы сроков</span>}
              value={pulse.delayed_orders_count}
              suffix={<span style={{ fontSize: 14 }}>зак.</span>}
              prefix={<ClockCircleOutlined style={{ color: "#ff4d4f" }} />}
              valueStyle={{
                fontWeight: "bold",
                color: pulse.delayed_orders_count > 0 ? "#a8071a" : "#389e0d",
              }}
            />
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {pulse.overdue_pieces_total > 0
                  ? `Просрочено: ${Math.round(pulse.overdue_pieces_total)} шт изделий`
                  : "Все заказы в графике"}
              </Text>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Оперативные рекомендации (Actionable Insights) */}
      {pulse.insights.length > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <ThunderboltOutlined style={{ color: "#faad14" }} />
              <span style={{ fontWeight: 600 }}>Оперативные рекомендации директорату</span>
            </Space>
          }
          extra={
            <Button
              type="text"
              icon={<ReloadOutlined spin={isFetching} />}
              onClick={() => refetch()}
              size="small"
            >
              Обновить
            </Button>
          }
          style={{ borderRadius: 8 }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pulse.insights.map((ins, idx) => (
              <Alert
                key={idx}
                type={ins.level === "danger" ? "error" : ins.level}
                showIcon
                message={<strong>{ins.title}</strong>}
                description={ins.text}
                action={
                  ins.action_link ? (
                    <Button
                      size="small"
                      type={ins.level === "danger" ? "primary" : "default"}
                      danger={ins.level === "danger"}
                      icon={<ArrowRightOutlined />}
                      onClick={() => navigate(ins.action_link!)}
                    >
                      {ins.action_label || "Перейти"}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </div>
        </Card>
      )}

      {/* Балансировка участков и выявление узких мест */}
      <Card
        size="small"
        title={
          <Space>
            <FireOutlined style={{ color: "#ff4d4f" }} />
            <span style={{ fontWeight: 600 }}>Баланс мощностей и узкие места участков</span>
          </Space>
        }
        style={{ borderRadius: 8 }}
      >
        <Row gutter={[16, 16]}>
          {pulse.area_balances.map((area) => {
            const isWarn = area.days_of_work > 2.0;
            const isDanger = area.is_bottleneck || area.days_of_work > 3.0;
            const barColor = isDanger ? "#ff4d4f" : isWarn ? "#faad14" : "#52c41a";

            return (
              <Col xs={24} sm={12} md={8} lg={6} key={area.area_code}>
                <div
                  style={{
                    border: `1px solid ${isDanger ? "#ffa39e" : "#f0f0f0"}`,
                    borderRadius: 6,
                    padding: 10,
                    background: isDanger ? "#fff1f0" : "#fff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <Text strong style={{ fontSize: 13 }}>
                      {area.name}
                    </Text>
                    {isDanger ? (
                      <Tag color="error">Узкое место</Tag>
                    ) : isWarn ? (
                      <Tag color="warning">Нагрузка</Tag>
                    ) : (
                      <Tag color="success">Норма</Tag>
                    )}
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <Text type="secondary">Очередь:</Text>
                    <Text strong>{Math.round(area.queue_pieces)} шт ({area.days_of_work.toFixed(1)} дн.)</Text>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                    <Text type="secondary">Мощность:</Text>
                    <Text type="secondary">{Math.round(area.capacity_per_day)} шт/день</Text>
                  </div>

                  <Tooltip title={`Загрузка: ${area.load_pct}% от 2-дневного горизонта нормального темпа`}>
                    <Progress
                      percent={Math.min(100, Math.round((area.days_of_work / 3.0) * 100))}
                      strokeColor={barColor}
                      showInfo={false}
                      size="small"
                    />
                  </Tooltip>
                </div>
              </Col>
            );
          })}
        </Row>
      </Card>
    </div>
  );
};

export default DirectorPulse;
