import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ACTION_DENIED_EVENT, type ActionDenied } from "../api/client";
import { actionRequestsSummary, approveActionRequest, createActionRequest } from "../api/control";
import { apiErrorMessage } from "../utils/apiError";

/** «Попросить администратора» (07.10): любое действие, в котором отказали
 * (нет прав или период закрыт), можно отправить на подтверждение —
 * администратор выполнит его от своего имени. Тот, кто сам подтверждает
 * запросы, при закрытом периоде может выполнить сразу (запрос всё равно
 * остаётся в журнале). */
export default function ActionRequestPrompt() {
  const qc = useQueryClient();
  const [denied, setDenied] = useState<ActionDenied | null>(null);
  const [comment, setComment] = useState("");
  const summaryQuery = useQuery({ queryKey: ["action-requests-summary"], queryFn: actionRequestsSummary, staleTime: 60_000 });
  const canApprove = !!summaryQuery.data?.can_approve;

  useEffect(() => {
    const onDenied = (e: Event) => {
      const d = (e as CustomEvent<ActionDenied>).detail;
      setDenied(d);
      setComment("");
    };
    window.addEventListener(ACTION_DENIED_EVENT, onDenied);
    return () => window.removeEventListener(ACTION_DENIED_EVENT, onDenied);
  }, []);

  const close = () => setDenied(null);
  const refresh = () => {
    for (const k of ["action-requests-summary", "action-requests"]) qc.invalidateQueries({ queryKey: [k] });
  };

  const send = useMutation({
    mutationFn: async (runNow: boolean) => {
      const req = await createActionRequest({
        method: denied!.method,
        path: denied!.path,
        body: denied!.body,
        error: denied!.error,
        kind: denied!.kind,
        page: window.location.pathname + window.location.search,
        comment: comment.trim() || (runNow ? "Выполнено администратором сразу" : ""),
      });
      return runNow ? approveActionRequest(req.id) : req;
    },
    onSuccess: (req) => {
      refresh();
      close();
      if (req.status === "pending") message.success("Запрос отправлен администратору — ответ появится в «Запросах» в шапке");
      else if (req.status === "done") {
        message.success("Выполнено");
        qc.invalidateQueries();
      } else message.error(req.result ?? "Не выполнено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отправить запрос")),
  });

  if (!denied) return null;
  const closedPeriod = denied.kind === "period_closed";
  return (
    <Modal
      open
      title={closedPeriod ? "Период закрыт" : "Недостаточно прав"}
      onCancel={close}
      footer={
        <Space wrap>
          <Button onClick={close}>Отмена</Button>
          {canApprove && closedPeriod && (
            <Button danger loading={send.isPending} onClick={() => send.mutate(true)}>
              Выполнить всё равно
            </Button>
          )}
          <Button type="primary" loading={send.isPending} disabled={!comment.trim()} onClick={() => send.mutate(false)}>
            Попросить администратора
          </Button>
        </Space>
      }
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        {denied.error && <Alert type="warning" showIcon message={denied.error} />}
        <Typography.Text>
          Администратор получит запрос именно на это действие и сможет выполнить его или отклонить. Ответ появится в «Запросах»
          в шапке.
        </Typography.Text>
        <Input.TextArea
          autoFocus
          rows={3}
          maxLength={500}
          placeholder="Зачем нужно — например, «отчёт за 30.09 забыли внести»"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {canApprove && closedPeriod && (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            Вы подтверждаете запросы сами: «Выполнить всё равно» проведёт действие в закрытом периоде и запишет это в журнал
            запросов.
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}
