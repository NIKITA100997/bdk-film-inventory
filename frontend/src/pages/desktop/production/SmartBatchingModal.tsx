import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Modal,
  Card,
  Row,
  Col,
  Statistic,
  Table,
  Tag,
  Button,
  Space,
  Typography,
  Alert,
  Spin,
  Tabs,
  message,
} from "antd";
import {
  ThunderboltOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  SwapOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { apiClient } from "../../../api/client";

const { Text } = Typography;

interface SmartBatchingItem {
  line_id: number;
  task_id: number;
  task_name: string;
  part_name: string;
  decor_name: string;
  material_name: string;
  color_name: string;
  width_mm: number;
  length_m: number;
  remaining_pieces: number;
  due_date: string | null;
  urgency_score: number;
}

interface SmartBatchingPreview {
  area: string;
  target_date: string;
  total_lines: number;
  total_pieces: number;
  original_changeovers: number;
  optimized_changeovers: number;
  changeovers_saved: number;
  estimated_minutes_saved: number;
  original_sequence: SmartBatchingItem[];
  optimized_sequence: SmartBatchingItem[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  area: string;
  areaName?: string;
}

export const SmartBatchingModal: React.FC<Props> = ({ open, onClose, area, areaName }) => {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<string>("optimized");

  const { data: preview, isLoading, refetch, isFetching } = useQuery<SmartBatchingPreview>({
    queryKey: ["smartBatchingPreview", area],
    queryFn: async () =>
      (await apiClient.get<SmartBatchingPreview>("/smart-batching-preview", { params: { area } })).data,
    enabled: open && !!area,
  });

  const applyMutation = useMutation({
    mutationFn: async (lineIds: number[]) =>
      (await apiClient.post("/smart-batching-apply", { area, line_ids: lineIds })).data,
    onSuccess: (res: any) => {
      message.success(
        `Оптимизированная очередь применена: упорядочено ${res.applied_lines_count} строк заданий!`
      );
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["daily-sheet"] });
      qc.invalidateQueries({ queryKey: ["plan-slots"] });
      onClose();
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail || "Ошибка применения оптимизации");
    },
  });

  const columns = [
    {
      title: "№",
      key: "idx",
      width: 50,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Срочность",
      dataIndex: "urgency_score",
      key: "urgency_score",
      width: 100,
      render: (score: number) => {
        if (score === 0) return <Tag color="error">Сегодня / Срок</Tag>;
        if (score === 1) return <Tag color="warning">Ближайшие 2 дня</Tag>;
        return <Tag color="default">Гибко</Tag>;
      },
    },
    {
      title: "Декор плёнки",
      dataIndex: "decor_name",
      key: "decor_name",
      render: (text: string) => <Text strong>{text}</Text>,
    },
    {
      title: "Ширина",
      dataIndex: "width_mm",
      key: "width_mm",
      align: "right" as const,
      width: 100,
      render: (w: number) => `${Math.round(w)} мм`,
    },
    {
      title: "Деталь / Задание",
      key: "task",
      render: (_: any, r: SmartBatchingItem) => (
        <div>
          <div>{r.part_name}</div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {r.task_name}
          </Text>
        </div>
      ),
    },
    {
      title: "Остаток",
      dataIndex: "remaining_pieces",
      key: "remaining_pieces",
      align: "right" as const,
      width: 100,
      render: (p: number) => `${Math.round(p)} шт`,
    },
    {
      title: "Срок",
      dataIndex: "due_date",
      key: "due_date",
      width: 110,
      render: (d: string | null) => (d ? new Date(d).toLocaleDateString("ru-RU") : "—"),
    },
  ];

  return (
    <Modal
      title={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingRight: 32 }}>
          <Space>
            <ThunderboltOutlined style={{ color: "#faad14" }} />
            <span>Умная диспетчеризация очередей (Smart Batching) — {areaName || area}</span>
          </Space>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined spin={isFetching} />}
            onClick={() => refetch()}
          >
            Обновить
          </Button>
        </div>
      }
      open={open}
      onCancel={onClose}
      width={900}
      footer={[
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
        <Button
          key="apply"
          type="primary"
          icon={<CheckCircleOutlined />}
          loading={applyMutation.isPending}
          disabled={!preview || preview.optimized_sequence.length === 0}
          onClick={() => {
            if (preview) {
              const ids = preview.optimized_sequence.map((item) => item.line_id);
              applyMutation.mutate(ids);
            }
          }}
          style={{ background: "#52c41a", borderColor: "#52c41a" }}
        >
          🚀 Применить оптимизацию в цех
        </Button>,
      ]}
    >
      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin tip="Расчёт оптимальной последовательности переналадок..." />
        </div>
      ) : !preview || preview.total_lines === 0 ? (
        <Alert
          type="info"
          message="Нет открытых заданий для оптимизации"
          description="Все текущие задания по выбранному участку выполнены или закрыты."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Сводные показатели экономии времени */}
          <Row gutter={[12, 12]}>
            <Col span={6}>
              <Card size="small" style={{ textAlign: "center", background: "#fafafa" }}>
                <Statistic
                  title="Текущие смены"
                  value={preview.original_changeovers}
                  suffix="переналадок"
                  valueStyle={{ color: "#8c8c8c" }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small" style={{ textAlign: "center", background: "#f6ffed", borderColor: "#b7eb8f" }}>
                <Statistic
                  title="После оптимизации"
                  value={preview.optimized_changeovers}
                  suffix="переналадок"
                  valueStyle={{ color: "#389e0d", fontWeight: "bold" }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small" style={{ textAlign: "center", background: "#e6f7ff", borderColor: "#91d5ff" }}>
                <Statistic
                  title="Сокращено"
                  value={preview.changeovers_saved}
                  prefix={<SwapOutlined />}
                  suffix="смен рулона"
                  valueStyle={{ color: "#096dd9", fontWeight: "bold" }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small" style={{ textAlign: "center", background: "#fff7e6", borderColor: "#ffd591" }}>
                <Statistic
                  title="Экономия времени"
                  value={preview.estimated_minutes_saved}
                  suffix="мин"
                  prefix={<ClockCircleOutlined />}
                  valueStyle={{ color: "#d46b08", fontWeight: "bold" }}
                />
              </Card>
            </Col>
          </Row>

          {preview.changeovers_saved > 0 ? (
            <Alert
              type="success"
              showIcon
              message={
                <span>
                  Оптимизация сокращает <strong>{preview.changeovers_saved} лишних смен рулонов и перенастроек роликов</strong>, экономя цеху ориентировочно <strong>{preview.estimated_minutes_saved} минут</strong> рабочего времени!
                </span>
              }
            />
          ) : (
            <Alert
              type="info"
              showIcon
              message="Текущая очередь уже близка к оптимальной (минимальное число переналадок)."
            />
          )}

          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: "optimized",
                label: `🎯 Оптимизированная очередь (${preview.optimized_sequence.length})`,
                children: (
                  <Table
                    rowKey="line_id"
                    columns={columns}
                    dataSource={preview.optimized_sequence}
                    pagination={false}
                    size="small"
                    scroll={{ y: 350 }}
                  />
                ),
              },
              {
                key: "original",
                label: `Исходный порядок (${preview.original_sequence.length})`,
                children: (
                  <Table
                    rowKey="line_id"
                    columns={columns}
                    dataSource={preview.original_sequence}
                    pagination={false}
                    size="small"
                    scroll={{ y: 350 }}
                  />
                ),
              },
            ]}
          />
        </div>
      )}
    </Modal>
  );
};

export default SmartBatchingModal;
