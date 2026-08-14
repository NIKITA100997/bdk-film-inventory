import { useState } from "react";
import { Card, Tag, Button, Modal, Form, Input, Space, Typography, Empty, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listDeletionRequests,
  approveDeletionRequest,
  rejectDeletionRequest,
  ENTITY_TYPE_LABELS,
  type DeletionRequest,
} from "../../api/deletionRequests";
import ResponsiveTable from "../../components/ResponsiveTable";

const STATUS_TAG: Record<DeletionRequest["status"], { color: string; label: string }> = {
  pending: { color: "orange", label: "Ожидает" },
  approved: { color: "green", label: "Одобрена" },
  rejected: { color: "default", label: "Отклонена" },
};

/** Заявки на удаление (раздел про удаление сущностей) — сотрудники без
 * прав суперпользователя вместо прямого удаления заказов/заданий/
 * заявок/плёнок отправляют заявку сюда, суперпользователь одобряет
 * (реально удаляет) или отклоняет. Тот же паттерн работы с очередью, что
 * "Заявки поставщику" на "Закупках" — фильтр по статусу, действия в
 * строке таблицы. */
export default function DeletionRequests() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [rejecting, setRejecting] = useState<DeletionRequest | null>(null);
  const [rejectForm] = Form.useForm<{ note?: string }>();

  const requestsQuery = useQuery({
    queryKey: ["deletion-requests", statusFilter],
    queryFn: () => listDeletionRequests(statusFilter || undefined),
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => approveDeletionRequest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deletion-requests"] });
      message.success("Удалено");
    },
    onError: () => message.error("Не удалось удалить — возможно, у сущности появилась история"),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note?: string }) => rejectDeletionRequest(id, note),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deletion-requests"] });
      setRejecting(null);
      message.success("Заявка отклонена");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Заявки на удаление">
        <Typography.Paragraph type="secondary">
          Сотрудники без прав суперпользователя вместо прямого удаления отправляют заявку сюда — «Одобрить» удаляет
          сущность по-настоящему, «Отклонить» оставляет её как есть.
        </Typography.Paragraph>
        <Space style={{ marginBottom: 12 }}>
          <Button size="small" type={statusFilter === "pending" ? "primary" : "default"} onClick={() => setStatusFilter("pending")}>
            Ожидают
          </Button>
          <Button size="small" type={statusFilter === "" ? "primary" : "default"} onClick={() => setStatusFilter("")}>
            Все
          </Button>
        </Space>
        {(requestsQuery.data ?? []).length === 0 ? (
          <Empty description="Заявок нет" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <ResponsiveTable<DeletionRequest>
            tableKey="deletion-requests"
            lockedColumns={["Что", "Действия"]}
            rowKey="id"
            loading={requestsQuery.isLoading}
            dataSource={requestsQuery.data ?? []}
            pagination={{ pageSize: 20 }}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Тип", dataIndex: "entity_type", render: (v: DeletionRequest["entity_type"]) => ENTITY_TYPE_LABELS[v] },
              { title: "Что", dataIndex: "entity_label" },
              { title: "Причина", dataIndex: "reason", render: (v: string | null) => v ?? "—" },
              { title: "Кто запросил", dataIndex: "requested_by_name" },
              { title: "Когда", dataIndex: "created_at", render: (v: string) => new Date(v).toLocaleString("ru-RU") },
              {
                title: "Статус",
                dataIndex: "status",
                render: (v: DeletionRequest["status"], r) => (
                  <Space direction="vertical" size={0}>
                    <Tag color={STATUS_TAG[v].color}>{STATUS_TAG[v].label}</Tag>
                    {r.resolution_note && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {r.resolution_note}
                      </Typography.Text>
                    )}
                  </Space>
                ),
              },
              {
                title: "Действия",
                render: (_, r) =>
                  r.status === "pending" && (
                    <Space>
                      <Button size="small" type="primary" loading={approveMutation.isPending} onClick={() => approveMutation.mutate(r.id)}>
                        Одобрить
                      </Button>
                      <Button size="small" onClick={() => setRejecting(r)}>
                        Отклонить
                      </Button>
                    </Space>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Modal
        title={`Отклонить заявку — ${rejecting?.entity_label ?? ""}`}
        open={!!rejecting}
        onCancel={() => setRejecting(null)}
        footer={null}
        destroyOnHidden
      >
        <Form form={rejectForm} layout="vertical" onFinish={(v) => rejectMutation.mutate({ id: rejecting!.id, note: v.note })}>
          <Form.Item name="note" label="Комментарий (необязательно)">
            <Input placeholder="Например: пригодится ещё" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={rejectMutation.isPending}>
            Отклонить
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
