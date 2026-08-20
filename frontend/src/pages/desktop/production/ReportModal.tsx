import { useState } from "react";
import { Modal, Form, Select, InputNumber, Input, Button, Table, Typography, message } from "antd";
import dayjs from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createTaskLineReport, type ProductionTaskLine } from "../../../api/production";
import { listWriteOffReasons } from "../../../api/writeOffReasons";

/** Отчёт о производстве/браке (раздел про брак по дням) — отчёт всегда
 * привязан к конкретной записи распределения (день/линия/сотрудники), не
 * к строке задания целиком, поэтому используется и из общего списка
 * заданий (мастер сам выбирает распределение из списка строки), и из
 * «Плана на день» (распределение уже известно — presetAssignmentId). */
export default function ReportModal({
  taskId,
  line,
  presetAssignmentId,
  onClose,
}: {
  taskId: number;
  line: ProductionTaskLine;
  presetAssignmentId?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [defectRows, setDefectRows] = useState<{ reason: string; qty: number; note?: string }[]>([]);
  const [reportForm] = Form.useForm<{ assignment_id: number; good_pieces: number }>();
  const [defectRowForm] = Form.useForm<{ reason: string; qty: number; note?: string }>();
  const writeOffReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "production"],
    queryFn: () => listWriteOffReasons("production"),
  });
  const reasonName = (code: string) => writeOffReasonsQuery.data?.find((r) => r.code === code)?.name ?? code;

  const addDefectRow = (v: { reason: string; qty: number; note?: string }) => {
    setDefectRows((rows) => [...rows, v]);
    defectRowForm.resetFields();
  };
  const removeDefectRow = (index: number) => setDefectRows((rows) => rows.filter((_, i) => i !== index));

  const reportMutation = useMutation({
    // Раздел про несколько причин брака в одном отчёте — накопительный
    // журнал (ProductionTaskLineReport) уже это поддерживает: просто шлём
    // несколько строк вместо одной (хорошие детали отдельной строкой,
    // затем по одной строке на каждую причину брака), агрегаты суммируют
    // их на бэкенде так же, как если бы это были отчёты за разные смены.
    mutationFn: async (v: { assignment_id: number; good_pieces: number }) => {
      const calls: Promise<unknown>[] = [];
      if (v.good_pieces > 0) {
        calls.push(
          createTaskLineReport(taskId, line.id, {
            assignment_id: v.assignment_id,
            good_pieces: v.good_pieces,
            defect_pieces: 0,
          }),
        );
      }
      for (const row of defectRows) {
        calls.push(
          createTaskLineReport(taskId, line.id, {
            assignment_id: v.assignment_id,
            good_pieces: 0,
            defect_pieces: row.qty,
            defect_reason: row.reason,
            note: row.note,
          }),
        );
      }
      await Promise.all(calls);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success("Отчёт сохранён");
      onClose();
    },
    onError: () => message.error("Не удалось сохранить отчёт"),
  });

  return (
    <Modal title={`Отчёт по линии «${line.part_name ?? line.line_name}»`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Нужно: {line.quantity_pieces} шт, уже произведено: {line.produced_good_pieces} шт, остаток: {line.remaining_pieces} шт.
      </Typography.Paragraph>
      <Form layout="vertical" form={reportForm} initialValues={{ assignment_id: presetAssignmentId, good_pieces: 0 }}>
        <Form.Item name="assignment_id" label="Распределение (день/линия)" rules={[{ required: true }]}>
          <Select
            disabled={!!presetAssignmentId}
            placeholder="Выберите день/линию распределения"
            options={line.assignments.map((a) => ({
              value: a.id,
              label: `${dayjs(a.date).format("DD.MM.YYYY")} — ${a.line_name} (${a.employee_names}), план ${a.quantity_pieces} шт`,
            }))}
            notFoundContent={
              <Typography.Text type="secondary">
                Сначала распределите строку по дням — кнопка «Распределить по дням»
              </Typography.Text>
            }
          />
        </Form.Item>
        <Form.Item name="good_pieces" label="Хороших деталей, шт" rules={[{ required: true }]}>
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
      </Form>

      {defectRows.length > 0 && (
        <Table
          rowKey={(_, i) => String(i)}
          size="small"
          pagination={false}
          dataSource={defectRows}
          style={{ marginBottom: 16 }}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Причина брака", dataIndex: "reason", render: (v: string) => reasonName(v) },
            { title: "Кол-во, шт", dataIndex: "qty" },
            { title: "Заметка", render: (_, r) => r.note ?? "—" },
            {
              title: "",
              render: (_, __, index) => (
                <Button size="small" danger onClick={() => removeDefectRow(index)}>
                  Убрать
                </Button>
              ),
            },
          ]}
        />
      )}

      <Typography.Title level={5}>Добавить причину брака</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        Брак может быть по нескольким причинам сразу — например, 1 деталь мусор под плёнкой, 2 деталь царапины:
        добавьте отдельную строку на каждую причину.
      </Typography.Paragraph>
      <Form form={defectRowForm} layout="vertical" onFinish={addDefectRow}>
        <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
          <Select
            loading={writeOffReasonsQuery.isLoading}
            options={(writeOffReasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))}
          />
        </Form.Item>
        <Form.Item name="qty" label="Количество, шт" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="note" label="Заметка (опционально)">
          <Input placeholder="Например: мусор под плёнкой" />
        </Form.Item>
        <Button htmlType="submit" block>
          Добавить причину
        </Button>
      </Form>

      <Button
        type="primary"
        block
        style={{ marginTop: 16 }}
        loading={reportMutation.isPending}
        onClick={() => {
          reportForm
            .validateFields()
            .then((v) => {
              if ((v.good_pieces ?? 0) <= 0 && defectRows.length === 0) {
                message.warning("Укажите хотя бы хорошие детали или причину брака");
                return;
              }
              reportMutation.mutate(v);
            })
            .catch(() => {});
        }}
      >
        Сохранить отчёт
      </Button>
    </Modal>
  );
}
