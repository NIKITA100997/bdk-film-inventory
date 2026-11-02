import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  PrinterOutlined,
  ThunderboltOutlined,
  WarningOutlined,
  FireOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  getQualityMeetingReport,
  type MachineDefectOut,
  type DecorDefectOut,
  type ParetoReasonOut,
} from "../../../api/reports";
import { listAreas } from "../../../api/areas";
import Statistic from "../../../components/Statistic";

const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("ru-RU");

type PeriodPreset = "today" | "this_week" | "last_week" | "this_month" | "last_month";

export default function QualityMeetingTab() {
  const [preset, setPreset] = useState<PeriodPreset>("this_week");
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [
    dayjs().startOf("week"),
    dayjs().endOf("day"),
  ]);
  const [area, setArea] = useState<string | null>(null);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });

  const setPeriod = (p: PeriodPreset) => {
    setPreset(p);
    const now = dayjs();
    if (p === "today") {
      setRange([now.startOf("day"), now.endOf("day")]);
    } else if (p === "this_week") {
      setRange([now.startOf("week"), now.endOf("day")]);
    } else if (p === "last_week") {
      const lastWk = now.subtract(1, "week");
      setRange([lastWk.startOf("week"), lastWk.endOf("week")]);
    } else if (p === "this_month") {
      setRange([now.startOf("month"), now.endOf("day")]);
    } else if (p === "last_month") {
      const lastM = now.subtract(1, "month");
      setRange([lastM.startOf("month"), lastM.endOf("month")]);
    }
  };

  const fromStr = range[0].format("YYYY-MM-DD");
  const toStr = range[1].format("YYYY-MM-DD");

  const reportQuery = useQuery({
    queryKey: ["quality-meeting-report", fromStr, toStr, area],
    queryFn: () => getQualityMeetingReport(fromStr, toStr, area),
  });

  const rep = reportQuery.data;

  const handlePrint = () => {
    window.print();
  };

  const defectRateColor = useMemo(() => {
    if (!rep) return "#52c41a";
    if (rep.total_defect_rate_percent >= 5.0) return "#cf1322";
    if (rep.total_defect_rate_percent >= 3.0) return "#faad14";
    return "#52c41a";
  }, [rep]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {/* Панель фильтров и действий */}
      <Card size="small" styles={{ body: { padding: "12px 16px" } }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <Space wrap size={8}>
            <span style={{ fontWeight: 600 }}>Период планёрки:</span>
            <Button
              size="small"
              type={preset === "this_week" ? "primary" : "default"}
              onClick={() => setPeriod("this_week")}
            >
              Эта неделя
            </Button>
            <Button
              size="small"
              type={preset === "last_week" ? "primary" : "default"}
              onClick={() => setPeriod("last_week")}
            >
              Прошлая неделя
            </Button>
            <Button
              size="small"
              type={preset === "today" ? "primary" : "default"}
              onClick={() => setPeriod("today")}
            >
              Сегодня
            </Button>
            <Button
              size="small"
              type={preset === "this_month" ? "primary" : "default"}
              onClick={() => setPeriod("this_month")}
            >
              Этот месяц
            </Button>
            <DatePicker.RangePicker
              size="small"
              value={range}
              onChange={(dates) => {
                if (dates && dates[0] && dates[1]) {
                  setRange([dates[0], dates[1]]);
                  setPreset("today"); // custom
                }
              }}
              allowClear={false}
              format="DD.MM.YYYY"
              style={{ width: 230 }}
            />
          </Space>

          <Space wrap size={8}>
            <Select
              size="small"
              style={{ minWidth: 180 }}
              placeholder="Все участки"
              allowClear
              value={area}
              onChange={setArea}
              options={[
                { value: "", label: "🏭 Все участки цеха" },
                ...(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name })),
              ]}
            />
            <Button
              size="small"
              icon={<PrinterOutlined />}
              onClick={handlePrint}
            >
              Печать для планёрки
            </Button>
          </Space>
        </div>
      </Card>

      {/* Верхние 4 карточки KPI */}
      <Row gutter={[12, 12]}>
        <Col xs={12} sm={6}>
          <Card size="small" styles={{ body: { padding: "12px 16px" } }}>
            <Statistic
              title="Общий брак за период"
              value={rep?.total_defect_pieces ?? 0}
              suffix="шт"
              precision={0}
              valueStyle={{ color: (rep?.total_defect_pieces ?? 0) > 0 ? "#cf1322" : "#52c41a", fontWeight: 700 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              из {fmt(rep?.total_good_pieces ?? 0)} шт годной продукции
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" styles={{ body: { padding: "12px 16px" } }}>
            <Statistic
              title="Доля брака цеха"
              value={rep?.total_defect_rate_percent ?? 0}
              suffix="%"
              precision={2}
              valueStyle={{ color: defectRateColor, fontWeight: 700 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              норматив фабрики: &le; 3.0%
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" styles={{ body: { padding: "12px 16px" } }}>
            <Statistic
              title="Финансовые потери"
              value={rep?.total_loss_rub ?? 0}
              suffix="₽"
              precision={0}
              valueStyle={{ color: "#d4380d", fontWeight: 700 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              плёнка в брак: ~{fmt(rep?.total_film_wasted_m ?? 0)} м
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" styles={{ body: { padding: "12px 16px" } }}>
            <Statistic
              title="Критический фокус (Зона А)"
              value={rep?.pareto_reasons.filter((r) => r.is_zone_a).length ?? 0}
              suffix="причин"
              valueStyle={{ color: "#1890ff", fontWeight: 700 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              дают 80% всех потерь фабрики
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      {/* Управленческое резюме Зоны А и рекомендации */}
      {rep && rep.total_defect_pieces > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <FireOutlined style={{ color: "#cf1322" }} />
              <span style={{ fontWeight: 600 }}>Решение совещания по качеству (Фокус недели)</span>
            </Space>
          }
          styles={{
            header: { background: "#fff1f0", borderBottom: "1px solid #ffa39e" },
            body: { padding: "12px 16px" },
          }}
        >
          <Typography.Paragraph style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>
            {rep.zone_a_summary}
          </Typography.Paragraph>

          {rep.recommended_actions.length > 0 && (
            <div>
              <Typography.Text strong style={{ fontSize: 13, color: "#595959" }}>
                План действий для технологов и мастеров смены:
              </Typography.Text>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {rep.recommended_actions.map((act, i) => (
                  <li key={i} style={{ marginBottom: 4, color: "#262626", fontSize: 13 }}>
                    {act}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {/* Парето-анализ причин брака (80/20) */}
      <Card
        size="small"
        title={
          <Space>
            <ThunderboltOutlined style={{ color: "#fa8c16" }} />
            <span style={{ fontWeight: 600 }}>Парето-анализ причин брака (Правило 80/20)</span>
            <Tag color="orange">Ранжирование по вкладу в потери</Tag>
          </Space>
        }
      >
        {!rep || rep.pareto_reasons.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Брак за выбранный период отсутствует" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              Красным выделена <b>Зона А</b> — 20% ключевых причин, устранение которых ликвидирует 80% объёма брака на фабрике.
            </Typography.Text>

            <Table<ParetoReasonOut>
              size="small"
              rowKey="reason_code"
              pagination={false}
              dataSource={rep.pareto_reasons}
              columns={[
                {
                  title: "Зона Парето",
                  render: (_, r) =>
                    r.is_zone_a ? (
                      <Tag color="error" style={{ fontWeight: 700 }}>
                        🔥 Зона А (80%)
                      </Tag>
                    ) : (
                      <Tag color="default">Зона B/C</Tag>
                    ),
                  width: 140,
                },
                {
                  title: "Причина дефекта",
                  dataIndex: "reason_name",
                  render: (name, r) => (
                    <span style={{ fontWeight: r.is_zone_a ? 600 : 400, color: r.is_zone_a ? "#cf1322" : undefined }}>
                      {name}
                    </span>
                  ),
                },
                {
                  title: "Брак, шт",
                  dataIndex: "defect_pieces",
                  render: (v) => <b>{fmt(v)}</b>,
                  align: "right",
                  width: 100,
                },
                {
                  title: "Доля от брака",
                  dataIndex: "share_percent",
                  render: (v) => (
                    <div style={{ width: 140 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                        <span>{v}%</span>
                      </div>
                      <Progress percent={v} showInfo={false} size="small" strokeColor="#ff4d4f" />
                    </div>
                  ),
                  width: 160,
                },
                {
                  title: "Накопительно (Кумулятивно)",
                  dataIndex: "cumulative_percent",
                  render: (v, r) => (
                    <div style={{ width: 160 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                        <span style={{ fontWeight: r.is_zone_a ? 700 : 400 }}>{v}%</span>
                        {r.is_zone_a && <span style={{ color: "#cf1322", fontSize: 11 }}>&le; 80%</span>}
                      </div>
                      <Progress
                        percent={v}
                        showInfo={false}
                        size="small"
                        strokeColor={r.is_zone_a ? "#cf1322" : "#1890ff"}
                      />
                    </div>
                  ),
                  width: 180,
                },
                {
                  title: "Потери, ₽",
                  dataIndex: "cost_rub",
                  render: (v) => <span style={{ color: "#d4380d", fontWeight: 500 }}>~{fmt(v)} ₽</span>,
                  align: "right",
                  width: 110,
                },
              ]}
            />
          </div>
        )}
      </Card>

      {/* Антирейтинги: Станки и Декоры (2 колонки) */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <WarningOutlined style={{ color: "#cf1322" }} />
                <span style={{ fontWeight: 600 }}>Антирейтинг станков и линий</span>
              </Space>
            }
          >
            {!rep || rep.machine_ranking.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет данных по линиям" />
            ) : (
              <Table<MachineDefectOut>
                size="small"
                rowKey={(r) => `${r.line_id}_${r.line_name}`}
                pagination={false}
                dataSource={rep.machine_ranking}
                columns={[
                  {
                    title: "Станок / Линия",
                    render: (_, r) => (
                      <Space orientation="vertical" size={0}>
                        <span style={{ fontWeight: 600 }}>{r.line_name}</span>
                        {r.area_name && (
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            {r.area_name}
                          </Typography.Text>
                        )}
                      </Space>
                    ),
                  },
                  {
                    title: "Брак",
                    dataIndex: "defect_pieces",
                    render: (v) => <b style={{ color: v > 0 ? "#cf1322" : undefined }}>{fmt(v)} шт</b>,
                    align: "right",
                  },
                  {
                    title: "% брака",
                    dataIndex: "defect_rate_percent",
                    render: (v) => {
                      const color = v >= 5.0 ? "red" : v >= 3.0 ? "orange" : "green";
                      return <Tag color={color}>{v}%</Tag>;
                    },
                    align: "right",
                  },
                  {
                    title: "Главная причина",
                    dataIndex: "top_reason",
                    render: (v) => v ? <Tag color="volcano" style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{v}</Tag> : "—",
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <WarningOutlined style={{ color: "#fa8c16" }} />
                <span style={{ fontWeight: 600 }}>Антирейтинг цветов и плёнок</span>
              </Space>
            }
          >
            {!rep || rep.decor_ranking.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет данных по декорам" />
            ) : (
              <Table<DecorDefectOut>
                size="small"
                rowKey={(r) => `${r.color_id}_${r.color_name}`}
                pagination={false}
                dataSource={rep.decor_ranking}
                columns={[
                  {
                    title: "Декор / Цвет",
                    dataIndex: "color_name",
                    render: (v) => <span style={{ fontWeight: 600 }}>{v}</span>,
                  },
                  {
                    title: "Брак",
                    dataIndex: "defect_pieces",
                    render: (v) => <b style={{ color: v > 0 ? "#cf1322" : undefined }}>{fmt(v)} шт</b>,
                    align: "right",
                  },
                  {
                    title: "% брака",
                    dataIndex: "defect_rate_percent",
                    render: (v) => {
                      const color = v >= 5.0 ? "red" : v >= 3.0 ? "orange" : "green";
                      return <Tag color={color}>{v}%</Tag>;
                    },
                    align: "right",
                  },
                  {
                    title: "Типовой дефект",
                    dataIndex: "top_reason",
                    render: (v) => v ? <Tag color="orange" style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{v}</Tag> : "—",
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
