import { useState } from "react";
import { Button, Card, Input, Modal, Popconfirm, Space, Table, Tabs, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  REQUEST_STATUS,
  actionRequestsSummary,
  approveActionRequest,
  listActionRequests,
  rejectActionRequest,
  type ActionRequest,
} from "../../api/control";
import { apiErrorMessage } from "../../utils/apiError";
import { fmtDateTime } from "../../utils/dates";
import { useTabTitle } from "../../layout/tabTitle";

/** Запросы администратору (07.10): сотруднику отказали (нет прав или период
 * закрыт) — он попросил выполнить действие. Подтверждающий выполняет его
 * от своего имени или отклоняет с причиной; сотрудник видит решение. */
export default function ActionRequests() {
  useTabTitle("Запросы администратору");
  const [params, setParams] = useSearchParams();
  const summaryQuery = useQuery({ queryKey: ["action-requests-summary"], queryFn: actionRequestsSummary });
  const canApprove = !!summaryQuery.data?.can_approve;
  const tab = params.get("tab") ?? (canApprove ? "pending" : "mine");
  const tabs = [
    ...(canApprove
      ? [
          { key: "pending", label: `Ждут решения${summaryQuery.data?.to_approve ? ` (${summaryQuery.data.to_approve})` : ""}` },
          { key: "all", label: "Все" },
        ]
      : []),
    { key: "mine", label: "Мои запросы" },
  ];
  return (
    <Card title="Запросы администратору">
      <Typography.Paragraph type="secondary" style={{ maxWidth: 820 }}>
        Когда действие запрещено — нет прав или период уже закрыт, — сотрудник может попросить администратора. Запрос хранит
        именно это действие: «Выполнить» проводит его от имени администратора (с пометкой, по чьей просьбе), «Отклонить» —
        с причиной.
      </Typography.Paragraph>
      <Tabs
        activeKey={tab}
        onChange={(k) => setParams({ tab: k }, { replace: true })}
        items={tabs.map((t) => ({ ...t, children: <RequestsTable scope={t.key as "pending" | "all" | "mine"} canApprove={canApprove} /> }))}
      />
    </Card>
  );
}

function RequestsTable({ scope, canApprove }: { scope: "pending" | "all" | "mine"; canApprove: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["action-requests", scope], queryFn: () => listActionRequests(scope) });
  const [rejecting, setRejecting] = useState<ActionRequest | null>(null);
  const [reason, setReason] = useState("");
  const refresh = () => {
    for (const k of ["action-requests", "action-requests-summary"]) qc.invalidateQueries({ queryKey: [k] });
  };
  const approve = useMutation({
    mutationFn: (id: number) => approveActionRequest(id),
    onSuccess: (r) => {
      refresh();
      if (r.status === "done") message.success("Выполнено");
      else message.error(r.result ?? "Не выполнено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось выполнить")),
  });
  const reject = useMutation({
    mutationFn: () => rejectActionRequest(rejecting!.id, reason.trim()),
    onSuccess: () => {
      refresh();
      setRejecting(null);
      message.success("Отклонено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отклонить")),
  });
  const showActions = canApprove && scope !== "mine";
  return (
    <>
      <Table<ActionRequest>
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={q.data ?? []}
        pagination={{ pageSize: 30 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: scope === "pending" ? "Запросов, ждущих решения, нет" : "Запросов нет" }}
        columns={[
          { title: "№", dataIndex: "id", width: 60 },
          { title: "Когда", render: (_, r) => fmtDateTime(r.created_at) },
          ...(scope !== "mine" ? [{ title: "Кто", render: (_: unknown, r: ActionRequest) => r.requested_by_name ?? "—" }] : []),
          {
            title: "Действие",
            render: (_, r) => (
              <Space direction="vertical" size={2} style={{ maxWidth: 420 }}>
                <Typography.Text strong>{r.summary}</Typography.Text>
                <Space size={4} wrap>
                  <Tag color={r.kind === "period_closed" ? "purple" : "orange"}>{r.kind === "period_closed" ? "период закрыт" : "нет прав"}</Tag>
                  {r.page && <Typography.Text type="secondary" style={{ fontSize: 12 }}>со страницы {r.page}</Typography.Text>}
                </Space>
                {r.error && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Отказ: {r.error}</Typography.Text>}
              </Space>
            ),
          },
          { title: "Зачем", render: (_, r) => <div style={{ maxWidth: 260, whiteSpace: "normal" }}>{r.comment}</div> },
          {
            title: "Статус",
            render: (_, r) => (
              <Space direction="vertical" size={2}>
                <Tag color={REQUEST_STATUS[r.status].color}>{REQUEST_STATUS[r.status].label}</Tag>
                {r.result && <Typography.Text style={{ fontSize: 12, maxWidth: 260, display: "block", whiteSpace: "normal" }}>{r.result}</Typography.Text>}
                {r.resolved_by_name && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.resolved_by_name}, {r.resolved_at ? fmtDateTime(r.resolved_at) : ""}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          ...(showActions
            ? [
                {
                  title: "",
                  render: (_: unknown, r: ActionRequest) =>
                    r.status === "pending" ? (
                      <Space>
                        <Popconfirm
                          title="Выполнить от вашего имени?"
                          description={r.summary}
                          okText="Выполнить"
                          cancelText="Нет"
                          onConfirm={() => approve.mutate(r.id)}
                        >
                          <Button size="small" type="primary" loading={approve.isPending && approve.variables === r.id}>
                            Выполнить
                          </Button>
                        </Popconfirm>
                        <Button
                          size="small"
                          onClick={() => {
                            setRejecting(r);
                            setReason("");
                          }}
                        >
                          Отклонить
                        </Button>
                      </Space>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
      <Modal
        open={!!rejecting}
        title={`Отклонить запрос №${rejecting?.id ?? ""}`}
        okText="Отклонить"
        cancelText="Отмена"
        okButtonProps={{ disabled: !reason.trim(), loading: reject.isPending }}
        onOk={() => reject.mutate()}
        onCancel={() => setRejecting(null)}
        destroyOnHidden
      >
        <Typography.Paragraph>{rejecting?.summary}</Typography.Paragraph>
        <Input.TextArea rows={3} maxLength={400} placeholder="Причина — её увидит сотрудник" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </>
  );
}
