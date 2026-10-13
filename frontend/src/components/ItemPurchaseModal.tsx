import { useEffect } from "react";
import { DatePicker, Form, Input, InputNumber, Modal, Select, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dayjs } from "dayjs";
import { createItemPurchaseRequest } from "../api/purchasing";
import { listMaterialStock } from "../api/materialStock";
import DictAutoComplete from "./DictAutoComplete";
import { apiErrorMessage } from "../utils/apiError";

interface Values {
  item_id: number;
  quantity: number;
  need_by?: Dayjs;
  supplier?: string;
  price_per_unit?: number;
  note?: string;
}

/** Заявка на закупку материала (14.10) — МДФ, пенопласт, клей… — так же, как
 * на плёнку: попадает в «Закупки → Заявки поставщику», объединяется в заказ
 * поставщику, по поставке — «Поступило» (приход на склад и закрытие). */
export default function ItemPurchaseModal({
  open,
  onClose,
  item,
  qty,
  note,
}: {
  open: boolean;
  onClose: () => void;
  /** позиция уже выбрана (из потребности) — иначе выбор из материалов */
  item?: { id: number; name: string; unit?: string | null } | null;
  qty?: number;
  note?: string;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const materials = useQuery({ queryKey: ["material-stock", false], queryFn: () => listMaterialStock(false), enabled: open && !item });
  const itemId = Form.useWatch("item_id", form);
  const unit = item?.unit ?? materials.data?.find((m) => m.item_id === itemId)?.unit ?? "";

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ item_id: item?.id, quantity: qty ? Math.round(qty * 1000) / 1000 : undefined, note });
    }
  }, [open, item, qty, note, form]);

  const create = useMutation({
    mutationFn: (v: Values) =>
      createItemPurchaseRequest({
        item_id: v.item_id,
        quantity: v.quantity,
        need_by: v.need_by ? v.need_by.format("YYYY-MM-DD") : null,
        supplier: v.supplier || undefined,
        price_per_unit: v.price_per_unit || undefined,
        note: v.note || undefined,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["material-demand"] });
      message.success(`Заявка №${r.id} создана — «Закупки → Заявки поставщику»`);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать заявку")),
  });

  return (
    <Modal
      title={item ? `Заявка на закупку: ${item.name}` : "Заявка на закупку материала"}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Создать заявку"
      confirmLoading={create.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
        <Form.Item name="item_id" label="Материал" rules={[{ required: true, message: "Выберите материал" }]} hidden={!!item}>
          <Select
            showSearch
            optionFilterProp="label"
            loading={materials.isLoading}
            placeholder="МДФ, пенопласт, клей…"
            options={(materials.data ?? []).map((m) => ({ value: m.item_id, label: `${m.name} (остаток ${Math.round(m.balance * 100) / 100} ${m.unit})` }))}
          />
        </Form.Item>
        <Form.Item name="quantity" label={`Количество${unit ? `, ${unit}` : ""}`} rules={[{ required: true, message: "Сколько заказать" }]}>
          <InputNumber min={0.001} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="need_by" label="Нужно к">
          <DatePicker format="DD.MM.YYYY" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="supplier" label="Поставщик (необязательно)">
          <DictAutoComplete kind="suppliers" />
        </Form.Item>
        <Form.Item name="price_per_unit" label={`Цена, ₽${unit ? ` за ${unit}` : ""} (необязательно)`}>
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="note" label="Комментарий">
          <Input maxLength={255} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
