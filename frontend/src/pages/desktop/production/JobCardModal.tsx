import { useRef } from "react";
import {
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Modal,
  Progress,
  QRCode,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import {
  PrinterOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { getJobCard, type JobCardData, type JobCardLine, type JobCardMaterial } from "../../../api/production";
import { printJobCard } from "../../../utils/printJobCard";

interface JobCardModalProps {
  taskId: number | null;
  open: boolean;
  onClose: () => void;
  onOpenFastReport?: (taskId: number) => void;
}

export default function JobCardModal({
  taskId,
  open,
  onClose,
  onOpenFastReport,
}: JobCardModalProps) {
  const qrRef = useRef<HTMLDivElement>(null);

  const { data: card, isLoading, error } = useQuery<JobCardData>({
    queryKey: ["jobCard", taskId],
    queryFn: () => getJobCard(taskId!),
    enabled: open && taskId != null,
  });

  const handlePrint = () => {
    if (!card) return;
    let qrDataUrl: string | undefined;
    const canvas = qrRef.current?.querySelector("canvas");
    if (canvas) {
      try {
        qrDataUrl = canvas.toDataURL("image/png");
      } catch {
        // ignore canvas extraction error
      }
    }
    printJobCard(card, qrDataUrl);
  };

  const copyQrValue = () => {
    if (!card) return;
    navigator.clipboard.writeText(card.qr_code_value);
    message.success(`Код наряда ${card.qr_code_value} скопирован`);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={1050}
      title={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PrinterOutlined style={{ color: "#1677ff", fontSize: 18 }} />
          <span>Маршрутная карта на станок (Job Card)</span>
          {card && <Tag color="blue">{card.area_name}</Tag>}
          {card?.primary_line_name && <Tag color="geekblue">{card.primary_line_name}</Tag>}
        </div>
      }
      footer={[
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
        onOpenFastReport && card && (
          <Button
            key="fast"
            type="default"
            icon={<ThunderboltOutlined style={{ color: "#faad14" }} />}
            onClick={() => {
              onClose();
              onOpenFastReport(card.task_id);
            }}
          >
            Сдать выпуск в FastReport
          </Button>
        ),
        <Button
          key="print"
          type="primary"
          icon={<PrinterOutlined />}
          disabled={!card}
          onClick={handlePrint}
        >
          Распечатать наряд (А4)
        </Button>,
      ]}
    >
      {isLoading ? (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <Spin size="large" />
          <div style={{ marginTop: 12, color: "#888" }}>Формирование маршрутной карты задания...</div>
        </div>
      ) : error || !card ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#cf1322" }}>
          Не удалось загрузить данные сменного наряда.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Верхняя информационная панель с QR и показателями */}
          <Card
            styles={{ body: { padding: 16 } }}
            style={{ background: "#fbfbfb", border: "1px solid #e8e8e8" }}
          >
            <Row gutter={[16, 16]} align="middle">
              {/* QR-код с кодом задания */}
              <Col xs={24} sm={8} md={6} style={{ textAlign: "center" }}>
                <div
                  ref={qrRef}
                  style={{
                    display: "inline-block",
                    padding: 8,
                    background: "#fff",
                    borderRadius: 8,
                    border: "1px solid #d9d9d9",
                    cursor: "pointer",
                  }}
                  onClick={copyQrValue}
                  title="Нажмите, чтобы скопировать код"
                >
                  <QRCode value={card.qr_code_value} size={110} bordered={false} />
                  <Typography.Text
                    code
                    style={{ fontSize: 11, display: "block", marginTop: 4 }}
                  >
                    {card.qr_code_value} <CopyOutlined />
                  </Typography.Text>
                </div>
              </Col>

              {/* Мета-информация о заказе и задании */}
              <Col xs={24} sm={16} md={10}>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="Сменный наряд">
                    <Typography.Text strong style={{ fontSize: 15 }}>
                      № {card.task_id} {card.task_name ? `(${card.task_name})` : ""}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="Заказ клиента">
                    <Typography.Text strong>
                      {card.order_name || `Заказ №${card.external_order_ref || "—"}`}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="Срок отгрузки">
                    <Space orientation="horizontal" size="small">
                      <ClockCircleOutlined style={{ color: card.deadline_date ? "#faad14" : "#bfbfbf" }} />
                      <Typography.Text>
                        {card.deadline_date || "Не установлен"}
                      </Typography.Text>
                    </Space>
                  </Descriptions.Item>
                  {card.order_note && (
                    <Descriptions.Item label="Примечание">
                      <Typography.Text type="secondary" style={{ fontStyle: "italic" }}>
                        {card.order_note}
                      </Typography.Text>
                    </Descriptions.Item>
                  )}
                </Descriptions>
              </Col>

              {/* KPI прогресса */}
              <Col xs={24} md={8}>
                <div
                  style={{
                    background: "#fff",
                    padding: 12,
                    borderRadius: 8,
                    border: "1px solid #eee",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <Typography.Text type="secondary">Готовность партии:</Typography.Text>
                    <Typography.Text strong>{card.completion_percent}%</Typography.Text>
                  </div>
                  <Progress
                    percent={card.completion_percent}
                    status={card.completion_percent >= 100 ? "success" : "active"}
                    strokeColor={{ from: "#108ee9", to: "#87d068" }}
                  />
                  <Row gutter={8} style={{ marginTop: 12, textAlign: "center" }}>
                    <Col span={8}>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>План</Typography.Text>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{Math.round(card.total_quantity)}</div>
                    </Col>
                    <Col span={8}>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>Сдано</Typography.Text>
                      <div style={{ fontWeight: 700, fontSize: 16, color: "#389e0d" }}>
                        {Math.round(card.total_produced_good)}
                      </div>
                    </Col>
                    <Col span={8}>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>Брак</Typography.Text>
                      <div style={{ fontWeight: 700, fontSize: 16, color: card.total_defects > 0 ? "#cf1322" : "#8c8c8c" }}>
                        {Math.round(card.total_defects)}
                      </div>
                    </Col>
                  </Row>
                </div>
              </Col>
            </Row>
          </Card>

          {/* Сводка по сырью и плёнке */}
          {card.materials.length > 0 && (
            <div>
              <Typography.Title level={5} style={{ margin: "4px 0 8px" }}>
                1. Сырьё и плёнка под наряд
              </Typography.Title>
              <Table<JobCardMaterial>
                dataSource={card.materials}
                rowKey={(_, idx) => String(idx)}
                pagination={false}
                size="small"
                columns={[
                  {
                    title: "Материал / Декор",
                    key: "decor",
                    render: (_, m) => (
                      <Space orientation="horizontal" size="small">
                        <Tag color="cyan">{m.color || "Без цвета"}</Tag>
                        {m.material && <Typography.Text type="secondary">{m.material}</Typography.Text>}
                      </Space>
                    ),
                  },
                  {
                    title: "Толщина",
                    dataIndex: "thickness",
                    key: "thickness",
                    render: (t) => (t ? `${t} мм` : "—"),
                  },
                  {
                    title: "Ширина штрипса",
                    dataIndex: "strip_width_mm",
                    key: "strip_width_mm",
                    render: (w) => (w ? <b>{Math.round(w)} мм</b> : "—"),
                  },
                  {
                    title: "Расчётный метраж (+5%)",
                    dataIndex: "planned_meters",
                    key: "planned_meters",
                    render: (m) => <b>{m} м</b>,
                  },
                  {
                    title: "Выдано со склада",
                    dataIndex: "issued_meters",
                    key: "issued_meters",
                    render: (m) => (m > 0 ? `${m} м` : <Typography.Text type="secondary">—</Typography.Text>),
                  },
                  {
                    title: "Закреплённые рулоны",
                    dataIndex: "rolls_assigned",
                    key: "rolls_assigned",
                    render: (rolls: string[]) =>
                      rolls.length ? (
                        <Space wrap size={[4, 4]}>
                          {rolls.map((r, i) => (
                            <Tag key={i} color="blue">
                              {r}
                            </Tag>
                          ))}
                        </Space>
                      ) : (
                        <Typography.Text type="secondary">Рулон ещё не выдан</Typography.Text>
                      ),
                  },
                ]}
              />
            </div>
          )}

          {/* Детализация строк задания */}
          <div>
            <Typography.Title level={5} style={{ margin: "4px 0 8px" }}>
              2. Детали сменного задания ({card.lines.length} поз.)
            </Typography.Title>
            <Table<JobCardLine>
              dataSource={card.lines}
              rowKey="id"
              pagination={false}
              size="middle"
              columns={[
                {
                  title: "Деталь / Наименование",
                  key: "part",
                  render: (_, l) => (
                    <div>
                      <Typography.Text strong>{l.part_name || "Деталь"}</Typography.Text>
                      {l.operation_name && (
                        <div>
                          <Tag color="default" style={{ fontSize: 11 }}>{l.operation_name}</Tag>
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  title: "Размеры (Д x Ш x Т)",
                  dataIndex: "dimensions",
                  key: "dimensions",
                  render: (d) => <b>{d}</b>,
                },
                {
                  title: "Штрипс",
                  dataIndex: "strip_width_mm",
                  key: "strip_width_mm",
                  render: (w) => (w ? `${Math.round(w)} мм` : "—"),
                },
                {
                  title: "Программа / Схема",
                  key: "program",
                  render: (_, l) => (
                    <div>
                      {l.program ? <Typography.Text code>{l.program}</Typography.Text> : "—"}
                      {l.instruction && (
                        <div style={{ color: "#d48806", fontSize: 11 }}>⚑ {l.instruction}</div>
                      )}
                    </div>
                  ),
                },
                {
                  title: "План",
                  dataIndex: "quantity_pieces",
                  key: "quantity_pieces",
                  align: "right",
                  render: (q) => <b style={{ fontSize: 14 }}>{Math.round(q)}</b>,
                },
                {
                  title: "Сдано",
                  dataIndex: "produced_good_pieces",
                  key: "produced_good_pieces",
                  align: "right",
                  render: (p) => (
                    <Typography.Text style={{ color: p > 0 ? "#389e0d" : undefined, fontWeight: 600 }}>
                      {Math.round(p)}
                    </Typography.Text>
                  ),
                },
                {
                  title: "Остаток",
                  dataIndex: "remaining_pieces",
                  key: "remaining_pieces",
                  align: "right",
                  render: (rem) => (
                    <Typography.Text type={rem > 0 ? undefined : "secondary"}>
                      {Math.round(rem)}
                    </Typography.Text>
                  ),
                },
                {
                  title: "Статус",
                  key: "status",
                  align: "center",
                  render: (_, l) =>
                    l.production_closed || l.remaining_pieces <= 0 ? (
                      <Tag icon={<CheckCircleOutlined />} color="success">
                        Сдано
                      </Tag>
                    ) : (
                      <Tag icon={<ClockCircleOutlined />} color="processing">
                        В работе
                      </Tag>
                    ),
                },
              ]}
            />
          </div>

          {/* Связанные задания полуфабрикатов */}
          {card.pf_tasks.length > 0 && (
            <div>
              <Divider style={{ margin: "12px 0 8px" }} />
              <Typography.Title level={5} style={{ margin: "0 0 8px" }}>
                Связанные партии полуфабрикатов (ПФ)
              </Typography.Title>
              <Space wrap>
                {card.pf_tasks.map((pft) => (
                  <Tag
                    key={pft.id}
                    color={pft.is_ready ? "green" : "orange"}
                    style={{ padding: "4px 8px" }}
                  >
                    <b>№{pft.id}</b> {pft.name} ({pft.area_name}) — {pft.quantity} шт ·{" "}
                    {pft.is_ready ? "Готово к окутке" : "В производстве"}
                  </Tag>
                ))}
              </Space>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
