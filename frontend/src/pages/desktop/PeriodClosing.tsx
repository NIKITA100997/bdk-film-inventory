import { useState } from "react";
import { Alert, Button, Card, DatePicker, Input, Modal, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import { closePeriod, getPeriod, reopenPeriod, type PeriodRow } from "../../api/control";
import { apiErrorMessage } from "../../utils/apiError";
import { fmtDate, fmtDateTime } from "../../utils/dates";
import { useTabTitle } from "../../layout/tabTitle";

/** Закрытие периода (07.10): по закрытую дату задним числом ничего не
 * записывается и не правится — движения рулонов и партий, готовая
 * продукция, отчёты, цены. Открыть можно с причиной; всё — в истории.
 * Сотрудник, которому нужно внести что-то в закрытый период, просит
 * администратора (окно появится само). */
export default function PeriodClosing() {
  useTabTitle("Закрытие периода");
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("period.manage");
  const q = useQuery({ queryKey: ["period-closing"], queryFn: getPeriod });
  const current = q.data?.closed_until ? dayjs(q.data.closed_until) : null;
  const lastMonthEnd = dayjs().startOf("month").subtract(1, "day");
  const suggested = current && !current.isBefore(lastMonthEnd) ? null : lastMonthEnd;

  const [closeOpen, setCloseOpen] = useState(false);
  const [closeDate, setCloseDate] = useState<Dayjs | null>(null);
  const [closeReason, setCloseReason] = useState("");
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenDate, setReopenDate] = useState<Dayjs | null>(null);
  const [reopenReason, setReopenReason] = useState("");

  const done = (text: string) => {
    qc.invalidateQueries({ queryKey: ["period-closing"] });
    message.success(text);
  };
  const close = useMutation({
    mutationFn: () => closePeriod(closeDate!.format("YYYY-MM-DD"), closeReason.trim() || undefined),
    onSuccess: () => {
      setCloseOpen(false);
      done("Период закрыт");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось закрыть период")),
  });
  const reopen = useMutation({
    mutationFn: () => reopenPeriod(reopenDate ? reopenDate.format("YYYY-MM-DD") : null, reopenReason.trim()),
    onSuccess: () => {
      setReopenOpen(false);
      done("Период открыт");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось открыть период")),
  });

  return (
    <Card title="Закрытие периода">
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 820, margin: 0 }}>
          После закрытия по выбранную дату включительно ничего нельзя записать, исправить или удалить задним числом: движения
          рулонов и партий п/ф, склад готовой продукции, отчёты о производстве, цены. Остатки и себестоимость закрытых месяцев
          перестают меняться. Если что-то нужно внести — сотрудник просит администратора, или период открывают с причиной.
        </Typography.Paragraph>
        {current ? (
          <Alert type="info" showIcon message={<>Закрыто по <b>{fmtDate(q.data!.closed_until)}</b> включительно</>} />
        ) : (
          <Alert type="warning" showIcon message="Закрытых периодов нет — задним числом можно править любую дату" />
        )}
        {canManage && (
          <Space wrap>
            <Button
              type="primary"
              onClick={() => {
                setCloseDate(suggested ?? null);
                setCloseReason("");
                setCloseOpen(true);
              }}
            >
              {suggested ? `Закрыть ${suggested.format("MMMM YYYY")}` : "Закрыть период"}
            </Button>
            {current && (
              <Button
                onClick={() => {
                  setReopenDate(current.startOf("month").subtract(1, "day"));
                  setReopenReason("");
                  setReopenOpen(true);
                }}
              >
                Открыть период
              </Button>
            )}
          </Space>
        )}
        <Typography.Title level={5} style={{ margin: 0 }}>
          История
        </Typography.Title>
        <Table<PeriodRow>
          size="small"
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.data?.history ?? []}
          pagination={false}
          locale={{ emptyText: "Период ещё не закрывали" }}
          columns={[
            { title: "Когда", render: (_, r) => fmtDateTime(r.created_at) },
            { title: "Действие", render: (_, r) => (r.action === "close" ? <Tag color="blue">закрыт</Tag> : <Tag color="orange">открыт</Tag>) },
            { title: "Закрыто по", render: (_, r) => (r.closed_until ? fmtDate(r.closed_until) : "всё открыто") },
            { title: "Кто", render: (_, r) => r.user_name ?? "—" },
            { title: "Причина", render: (_, r) => r.reason ?? "" },
          ]}
        />
      </Space>

      <Modal
        open={closeOpen}
        title="Закрыть период"
        okText="Закрыть"
        cancelText="Отмена"
        okButtonProps={{ disabled: !closeDate, loading: close.isPending }}
        onOk={() => close.mutate()}
        onCancel={() => setCloseOpen(false)}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>Закрыть по дату включительно (обычно — последний день месяца):</Typography.Text>
          <DatePicker
            value={closeDate}
            onChange={setCloseDate}
            format="DD.MM.YYYY"
            disabledDate={(d) => !d.isBefore(dayjs(), "day") || (!!current && !d.isAfter(current, "day"))}
            style={{ width: 200 }}
          />
          <Input placeholder="Комментарий (необязательно)" maxLength={255} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} />
        </Space>
      </Modal>

      <Modal
        open={reopenOpen}
        title="Открыть период"
        okText="Открыть"
        cancelText="Отмена"
        okButtonProps={{ disabled: !reopenReason.trim(), loading: reopen.isPending }}
        onOk={() => reopen.mutate()}
        onCancel={() => setReopenOpen(false)}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            Сейчас закрыто по {current?.format("DD.MM.YYYY")}. Оставить закрытым по (пусто — открыть всё):
          </Typography.Text>
          <DatePicker
            value={reopenDate}
            onChange={setReopenDate}
            allowClear
            format="DD.MM.YYYY"
            disabledDate={(d) => !!current && !d.isBefore(current, "day")}
            style={{ width: 200 }}
          />
          <Input.TextArea rows={2} maxLength={255} placeholder="Причина — обязательно, останется в истории" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
        </Space>
      </Modal>
    </Card>
  );
}
