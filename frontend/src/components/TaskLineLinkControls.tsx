import { useState } from "react";
import { Button, Form, Input, Modal, Select, Space, Typography } from "antd";
import type { ProductionTask } from "../api/production";

// Раздел про сверку рулонов — привязка единицы к строке задания задним
// числом и пометка "старое бумажное задание", когда привязывать не к
// чему. Раньше жили только в RollReconciliationTab.tsx (сверка на
// окутке); вынесены сюда, чтобы карточка единицы (UnitCard.tsx) могла
// предложить то же самое для ЛЮБОГО участка, не только окутки.

export function LinkTaskLineForm({
  tasks,
  orderRef,
  loading,
  onSubmit,
}: {
  tasks: ProductionTask[];
  orderRef: (t: ProductionTask) => string;
  loading: boolean;
  onSubmit: (lineId: number) => void;
}) {
  const [taskId, setTaskId] = useState<number | null>(null);
  const [lineId, setLineId] = useState<number | null>(null);
  const task = tasks.find((t) => t.id === taskId);
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <div>
        <Typography.Text>Задание</Typography.Text>
        <Select
          style={{ width: "100%" }}
          placeholder="Выберите задание"
          value={taskId ?? undefined}
          onChange={(v) => {
            setTaskId(v);
            setLineId(null);
          }}
          options={tasks.map((t) => ({ value: t.id, label: orderRef(t) }))}
          showSearch
          optionFilterProp="label"
        />
      </div>
      <div>
        <Typography.Text>Строка задания</Typography.Text>
        <Select
          style={{ width: "100%" }}
          placeholder="Выберите строку"
          value={lineId ?? undefined}
          onChange={setLineId}
          disabled={!task}
          options={(task?.lines ?? []).map((l) => ({
            value: l.id,
            label: `${l.part_name ?? ""} ${l.color}, ${l.width_mm}×${l.length_m} м`.trim(),
          }))}
          showSearch
          optionFilterProp="label"
        />
      </div>
      <Button type="primary" block disabled={!lineId} loading={loading} onClick={() => lineId && onSubmit(lineId)}>
        Привязать
      </Button>
    </Space>
  );
}

export function LegacyNoteModal({
  initial,
  onCancel,
  onSubmit,
  loading,
}: {
  initial: string | null;
  onCancel: () => void;
  onSubmit: (note: string) => void;
  loading: boolean;
}) {
  const [form] = Form.useForm<{ note: string }>();
  return (
    <Modal
      title="Пометить как старое бумажное задание"
      open
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={loading}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ note: initial ?? "" }} onFinish={(v) => onSubmit(v.note)}>
        <Form.Item name="note" label="Заметка" rules={[{ required: true, message: "Опишите, что это за задание" }]}>
          <Input.TextArea rows={3} placeholder="Например: Заказ №8842 от 2026-08, бумажный наряд, в систему не заведён" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
