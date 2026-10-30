import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import {
  bulkCleanupCustomerOrders,
  getDraftsAudit,
  type DraftAuditItem,
} from "../../../api/customerOrders";
import { apiErrorMessage } from "../../../utils/apiError";

interface Props {
  open: boolean;
  onClose: () => void;
}

const REASON_COLOR: Record<DraftAuditItem["reason_code"], string> = {
  duplicate: "red",
  empty: "orange",
  stale: "volcano",
  already_produced: "purple",
};

export default function DraftsCleanupModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [action, setAction] = useState<"delete" | "cancel">("delete");
  const [reason, setReason] = useState<string>("stale_draft");

  const query = useQuery({
    queryKey: ["drafts-audit"],
    queryFn: () => getDraftsAudit(7),
    enabled: open,
  });

  const allItems = query.data ?? [];

  const filteredItems = useMemo(() => {
    if (tab === "all") return allItems;
    return allItems.filter((item) => item.reason_code === tab);
  }, [allItems, tab]);

  const cleanupMutation = useMutation({
    mutationFn: () =>
      bulkCleanupCustomerOrders({
        order_ids: selectedIds,
        action,
        reason,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      qc.invalidateQueries({ queryKey: ["drafts-audit"] });
      message.success(
        action === "delete"
          ? `Успешно удалено черновиков: ${res.cleaned_count}`
          : `Успешно отменено заказов: ${res.cleaned_count}`,
      );
      setSelectedIds([]);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Ошибка при очистке черновиков")),
  });

  const selectAll = () => {
    setSelectedIds(filteredItems.map((i) => i.id));
  };

  const clearSelection = () => {
    setSelectedIds([]);
  };

  const dupCount = allItems.filter((i) => i.reason_code === "duplicate").length;
  const staleCount = allItems.filter((i) => i.reason_code === "stale").length;
  const emptyCount = allItems.filter((i) => i.reason_code === "empty").length;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={950}
      title="🧹 Разбор и очистка зависших черновиков"
      footer={
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <div>
            <Typography.Text type="secondary">
              Выбрано черновиков: <b>{selectedIds.length}</b> из {filteredItems.length}
            </Typography.Text>
          </div>
          <Space>
            <Button onClick={onClose}>Отмена</Button>
            <Popconfirm
              title={
                action === "delete"
                  ? `Удалить выбранные черновики (${selectedIds.length} шт) безвозвратно?`
                  : `Отменить выбранные заказы (${selectedIds.length} шт)?`
              }
              onConfirm={() => cleanupMutation.mutate()}
              okText={action === "delete" ? "Да, удалить" : "Да, отменить"}
              okButtonProps={{ danger: true, loading: cleanupMutation.isPending }}
              disabled={selectedIds.length === 0}
            >
              <Button
                type="primary"
                danger
                disabled={selectedIds.length === 0}
                loading={cleanupMutation.isPending}
              >
                {action === "delete" ? "Удалить выбранные" : "Отменить выбранные"} (
                {selectedIds.length})
              </Button>
            </Popconfirm>
          </Space>
        </Space>
      }
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="Устранение накопившихся черновиков"
          description="Здесь собраны не запущенные заказы без движения, пустые черновики и возможные дубликаты. Массовое удаление не затрагивает принятые или запущенные в производство заказы."
        />

        {/* Action Controls */}
        <div
          style={{
            background: "#f7f9fa",
            padding: 12,
            borderRadius: 6,
            border: "1px solid #e2e8f0",
          }}
        >
          <Space wrap size={16} align="center">
            <span>
              <b>Действие:</b>
            </span>
            <Radio.Group
              value={action}
              onChange={(e) => setAction(e.target.value)}
              options={[
                { label: "Удалить без следа", value: "delete" },
                { label: "Пометить как «Отменён»", value: "cancel" },
              ]}
            />
            <span>
              <b>Причина:</b>
            </span>
            <Select
              value={reason}
              onChange={setReason}
              style={{ width: 220 }}
              options={[
                { value: "duplicate", label: "Ошибочный дубль счёта" },
                { value: "already_produced", label: "Уже изготовлен ранее" },
                { value: "client_cancelled", label: "Отменён клиентом" },
                { value: "stale_draft", label: "Устаревший черновик" },
              ]}
            />
            <Button size="small" onClick={selectAll}>
              Выбрать все ({filteredItems.length})
            </Button>
            {selectedIds.length > 0 && (
              <Button size="small" onClick={clearSelection}>
                Снять выбор
              </Button>
            )}
          </Space>
        </div>

        {/* Filter Tabs */}
        <Tabs
          activeKey={tab}
          onChange={(k) => {
            setTab(k);
            setSelectedIds([]);
          }}
          items={[
            { key: "all", label: `Все кандидаты (${allItems.length})` },
            { key: "duplicate", label: `🚨 Дубликаты (${dupCount})` },
            { key: "stale", label: `⌛ Зависшие > 7 дн. (${staleCount})` },
            { key: "empty", label: `📄 Пустые (${emptyCount})` },
          ]}
        />

        {/* Table */}
        <Table<DraftAuditItem>
          rowKey="id"
          size="small"
          loading={query.isLoading}
          dataSource={filteredItems}
          pagination={{ pageSize: 15, showSizeChanger: true }}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys as number[]),
          }}
          columns={[
            {
              title: "Счёт",
              render: (_, item) => (
                <Space orientation="vertical" size={0}>
                  <Typography.Text strong>№{item.id} · {item.invoice_no}</Typography.Text>
                  {item.customer && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {item.customer}
                    </Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: "Причина для разбора",
              render: (_, item) => (
                <Tag color={REASON_COLOR[item.reason_code]}>{item.reason_label}</Tag>
              ),
            },
            {
              title: "Позиций",
              align: "right",
              render: (_, item) =>
                item.lines_count === 0 ? (
                  <Typography.Text type="danger">0 (пусто)</Typography.Text>
                ) : (
                  <span>
                    {item.lines_count} поз. ({item.total_qty} шт)
                  </span>
                ),
            },
            {
              title: "Возраст черновика",
              align: "right",
              render: (_, item) => (
                <Space orientation="vertical" size={0} style={{ textAlign: "right" }}>
                  <span>{dayjs(item.created_at).format("DD.MM.YYYY")}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {item.days_idle} дн. без изменений
                  </Typography.Text>
                </Space>
              ),
            },
          ]}
        />
      </Space>
    </Modal>
  );
}

