import { useState } from "react";
import { isAxiosError } from "axios";
import { Button, Form, Input, InputNumber, Modal, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas } from "../../../api/areas";
import { createOperationTask, listAreaOperations } from "../../../api/production";

type LineDraft = { part_stage_id?: number | null; name?: string; quantity_pieces?: number };
type FormValues = { name: string; area: string; lines: LineDraft[] };

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** Задание без плёнки на любой участок (этап 3 единой модели — одно
 * задание): строка — операция техкарты (этап детали на этом участке; отчёт
 * двигает партии детали по маршруту) или просто работа, которую считают
 * штуками (упаковка и т.п.). */
export default function OperationTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [area, setArea] = useState<string | undefined>();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas, enabled: open });
  const opsQuery = useQuery({
    queryKey: ["production-operations", area],
    queryFn: () => listAreaOperations(area as string),
    enabled: open && !!area,
  });
  const opOptions = (opsQuery.data ?? []).map((o) => ({
    value: o.part_stage_id,
    label: `${o.part_name} · ${o.stage_name}${o.is_first ? " (рождает партию)" : ""}`,
  }));
  const lines = (Form.useWatch("lines", form) ?? []) as LineDraft[];

  const mutation = useMutation({
    mutationFn: (v: FormValues) =>
      createOperationTask({
        name: v.name.trim(),
        area: v.area,
        lines: v.lines.map((l) => ({
          part_stage_id: l.part_stage_id ?? null,
          name: l.part_stage_id ? null : (l.name ?? "").trim() || null,
          quantity_pieces: l.quantity_pieces as number,
        })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      message.success("Задание создано");
      form.resetFields();
      setArea(undefined);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать задание")),
  });

  return (
    <Modal title="Задание без плёнки" open={open} onCancel={onClose} footer={null} destroyOnHidden width={780}>
      <Typography.Paragraph type="secondary">
        Для работ без плёнки: сборка, склейка, фрезеровка, упаковка… Строка — операция детали п/ф (отчёт по ней
        двигает партии детали дальше по маршруту) или просто работа, которую считают штуками.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ lines: [{}] }} onFinish={(v) => mutation.mutate(v)}>
        <Space size={12} style={{ display: "flex" }} wrap>
          <Form.Item name="area" label="Участок" rules={[{ required: true, message: "Выберите участок" }]} style={{ width: 320 }}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Участок"
              loading={areasQuery.isLoading}
              options={(areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
              onChange={(v) => {
                setArea(v);
                form.setFieldValue("lines", [{}]);
              }}
            />
          </Form.Item>
          <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }]} style={{ flex: 1, minWidth: 260 }}>
            <Input placeholder="Например: Каркасы на запуск 16.09" />
          </Form.Item>
        </Space>
        <Typography.Text strong>Строки</Typography.Text>
        <Form.List name="lines">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => {
                const hasOp = !!lines[field.name]?.part_stage_id;
                return (
                  <Space key={field.key} align="start" wrap style={{ display: "flex", marginTop: 8 }}>
                    <Form.Item name={[field.name, "part_stage_id"]} style={{ width: 340, marginBottom: 0 }}>
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        disabled={!area}
                        placeholder={area ? "Операция детали п/ф" : "Сначала выберите участок"}
                        loading={opsQuery.isLoading}
                        options={opOptions}
                        notFoundContent={area ? "На участке нет операций деталей — впишите работу справа" : null}
                      />
                    </Form.Item>
                    {!hasOp && (
                      <Form.Item
                        name={[field.name, "name"]}
                        rules={[{ required: true, whitespace: true, message: "Операция или работа" }]}
                        style={{ width: 220, marginBottom: 0 }}
                      >
                        <Input placeholder="…или работа (упаковка)" />
                      </Form.Item>
                    )}
                    <Form.Item
                      name={[field.name, "quantity_pieces"]}
                      rules={[{ required: true, message: "Кол-во" }]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber min={1} placeholder="шт" style={{ width: 100 }} />
                    </Form.Item>
                    {fields.length > 1 && <Button onClick={() => remove(field.name)}>Убрать</Button>}
                  </Space>
                );
              })}
              <Button style={{ marginTop: 8 }} onClick={() => add({})}>
                + строка
              </Button>
            </>
          )}
        </Form.List>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending} style={{ marginTop: 16 }}>
          Создать
        </Button>
      </Form>
    </Modal>
  );
}
