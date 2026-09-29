import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Form, Modal, Select, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { createItemLaminated, getItemLaminated } from "../../../api/items";
import { listColors, listMaterials } from "../../../api/dictionaries";

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Деталь в плёнке в шапке карточки: у детали — её позиции «деталь · декор»
 * с остатком и «+ В плёнке…» (завести вручную, например под склад
 * ламинированных); у позиции в плёнке — ссылка на деталь без плёнки. */
export default function LaminatedBar({ itemId, canManage }: { itemId: number; canManage: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ material_id?: number; color_id: number }>();
  const query = useQuery({ queryKey: ["item-laminated", itemId], queryFn: () => getItemLaminated(itemId) });
  const materials = useQuery({ queryKey: ["materials"], queryFn: listMaterials, enabled: open });
  const colors = useQuery({ queryKey: ["colors"], queryFn: listColors, enabled: open });
  const mutation = useMutation({
    mutationFn: (v: { material_id?: number; color_id: number }) => createItemLaminated(itemId, v),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["item-laminated", itemId] });
      qc.invalidateQueries({ queryKey: ["items"] });
      setOpen(false);
      form.resetFields();
      message.success(`Позиция «${r.name}»`);
    },
    onError: (e) =>
      message.error(isAxiosError(e) && typeof e.response?.data?.detail === "string" ? e.response.data.detail : "Не удалось завести позицию"),
  });
  const data = query.data;
  if (!data) return null;
  if (data.base) {
    return (
      <Typography.Text type="secondary">
        В плёнке, деталь без плёнки: <a onClick={() => navigate(`/item/${data.base!.item_id}`)}>{data.base.name}</a>
      </Typography.Text>
    );
  }
  if (!data.can_laminate) return null;
  return (
    <Space wrap size={[6, 6]}>
      <Typography.Text type="secondary">В плёнке:</Typography.Text>
      {data.variants.length === 0 && <Typography.Text type="secondary">пока нет — появится с первым излишком окутки</Typography.Text>}
      {data.variants.map((v) => (
        <Tag key={v.item_id} color="blue" style={{ cursor: "pointer" }} onClick={() => navigate(`/item/${v.item_id}`)}>
          {v.name.split(" · ").slice(1).join(" · ") || v.name} — {fmt(v.stock)} шт
        </Tag>
      ))}
      {canManage && (
        <Button size="small" onClick={() => setOpen(true)}>
          + В плёнке…
        </Button>
      )}
      <Modal
        open={open}
        title="Позиция в плёнке"
        okText="Завести"
        cancelText="Отмена"
        confirmLoading={mutation.isPending}
        onOk={() => form.submit()}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Отдельная позиция «деталь · декор» со своим остатком — например, чтобы внести то, что лежит на складе
          ламинированных. Остаток вносится партией на её карточке.
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
          <Form.Item name="material_id" label="Материал плёнки">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={(materials.data ?? []).map((m) => ({ value: m.id, label: m.name }))}
            />
          </Form.Item>
          <Form.Item name="color_id" label="Декор (цвет)" rules={[{ required: true, message: "Выберите декор" }]}>
            <Select showSearch optionFilterProp="label" options={(colors.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
