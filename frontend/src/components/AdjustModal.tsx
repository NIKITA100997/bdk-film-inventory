import { Form, Input, InputNumber, Modal } from "antd";

/** Формальная «Корректировка» партии (плёнка — метры, п/ф — штуки): новое
 * фактическое значение + обязательная причина. */
export default function AdjustModal({
  open,
  title,
  currentValue,
  unitLabel,
  onCancel,
  onSubmit,
  loading,
}: {
  open: boolean;
  title: string;
  currentValue: number | undefined;
  unitLabel: string;
  onCancel: () => void;
  onSubmit: (v: { actual_value: number; reason: string; note?: string }) => void;
  loading: boolean;
}) {
  const [form] = Form.useForm<{ actual_value: number; reason: string; note?: string }>();
  return (
    <Modal title={title} open={open} onCancel={onCancel} onOk={() => form.submit()} okButtonProps={{ loading }} okText="Скорректировать" destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={onSubmit} initialValues={{ actual_value: currentValue }}>
        <Form.Item name="actual_value" label={`Фактическое значение, ${unitLabel}`} rules={[{ required: true }]}>
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="reason" label="Причина" rules={[{ required: true, message: "Укажите причину корректировки" }]}>
          <Input placeholder="Например: опечатка при вводе" />
        </Form.Item>
        <Form.Item name="note" label="Заметка (опционально)">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
