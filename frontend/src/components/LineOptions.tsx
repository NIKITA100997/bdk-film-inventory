import { useState } from "react";
import { AutoComplete, Button, Form, Modal, Space, Tag, Tooltip, Typography } from "antd";
import { EditOutlined } from "@ant-design/icons";
import type { LineOption, OptionField } from "../api/customerOrders";

/** Исполнение строки заказа (26.10): цвет кромки, тип стекла, уплотнитель…
 * Что пришло из счёта — метками; чего нет, но у позиции бывает — «уточнить».
 * onSave — правка (нет — только показ). */
export default function LineOptions({
  options,
  fields,
  onSave,
  saving,
  compact,
}: {
  options?: LineOption[] | null;
  fields?: OptionField[] | null;
  onSave?: (next: LineOption[]) => Promise<unknown> | void;
  saving?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<Record<string, string>>();
  const opts = (options ?? []).filter((o) => o.value);
  const have = new Set(opts.map((o) => o.code));
  const missing = (fields ?? []).filter((f) => !have.has(f.code));
  const allFields: OptionField[] = [
    ...(fields ?? []),
    // выбор, который пришёл из счёта, но у типа такого поля нет — тоже править
    ...opts.filter((o) => !(fields ?? []).some((f) => f.code === o.code)).map((o) => ({ code: o.code, name: o.name, op: o.op, value_type: "text", options: [] })),
  ];
  if (!opts.length && !missing.length && !onSave) return null;
  return (
    <>
      <Space size={[4, 2]} wrap>
        {opts.map((o) => (
          <Tooltip key={o.code} title={o.op ? `Указание мастеру на операции «${o.op}»` : "Указание мастеру"}>
            <Tag color="geekblue" style={{ marginInlineEnd: 0, fontSize: compact ? 11 : undefined }}>
              {o.name.toLowerCase()}: {o.value}
            </Tag>
          </Tooltip>
        ))}
        {missing.length > 0 && (
          <Tooltip title="Нет в счёте — уточните до запуска">
            <Tag color="gold" style={{ marginInlineEnd: 0, fontSize: compact ? 11 : undefined }}>
              уточнить: {missing.map((f) => f.name.toLowerCase()).join(", ")}
            </Tag>
          </Tooltip>
        )}
        {onSave && allFields.length > 0 && (
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            aria-label="Исполнение"
            title="Исполнение"
            onClick={() => {
              form.setFieldsValue(Object.fromEntries(allFields.map((f) => [f.code, opts.find((o) => o.code === f.code)?.value ?? ""])));
              setOpen(true);
            }}
          />
        )}
      </Space>
      {onSave && (
        <Modal
          title="Исполнение строки"
          open={open}
          onCancel={() => setOpen(false)}
          okText="Сохранить"
          confirmLoading={saving}
          destroyOnHidden
          onOk={async () => {
            const v = form.getFieldsValue();
            const next: LineOption[] = allFields
              .map((f) => ({ code: f.code, name: f.name, op: f.op ?? null, value: (v[f.code] ?? "").trim() }))
              .filter((o) => o.value);
            await onSave(next);
            setOpen(false);
          }}
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Не меняет позицию: уходит указанием мастеру на своей операции. Пусто — уточнят позже.
          </Typography.Paragraph>
          <Form form={form} layout="vertical">
            {allFields.map((f) => (
              <Form.Item key={f.code} name={f.code} label={f.op ? `${f.name} · ${f.op}` : f.name} style={{ marginBottom: 12 }}>
                <AutoComplete
                  allowClear
                  placeholder="не задано"
                  options={(f.options ?? []).map((o) => ({ value: o }))}
                  filterOption={(input, o) => String(o?.value ?? "").toLowerCase().includes(input.toLowerCase())}
                />
              </Form.Item>
            ))}
          </Form>
        </Modal>
      )}
    </>
  );
}
