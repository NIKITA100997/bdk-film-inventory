import { useState } from "react";
import { Button, Checkbox, Form, Input, InputNumber, Select, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dayjs } from "dayjs";
import { createMaterialMove, listMaterialStock } from "../api/materialStock";
import { listPurchaseRequests, receiveItemPurchaseRequest } from "../api/purchasing";
import OccurredAtField from "./OccurredAtField";
import { apiErrorMessage } from "../utils/apiError";
import { useAuth } from "../auth/AuthContext";
import { hasPerm } from "../auth/permissions";

interface Values {
  item_id: number;
  quantity: number;
  doc?: string;
  price?: number;
  request_id?: number;
  close?: boolean;
  occurred_at?: Dayjs | null;
}

/** Приход материала (МДФ, пенопласт, клей…) на «Приёмке» (14.10): по УПД,
 * с ценой; если поставка по открытой заявке — заявка закрывается. */
export default function MaterialReceiveForm() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [form] = Form.useForm<Values>();
  const itemId = Form.useWatch("item_id", form);
  const requestId = Form.useWatch("request_id", form);
  const [last, setLast] = useState<string | null>(null);
  const materials = useQuery({ queryKey: ["material-stock", false], queryFn: () => listMaterialStock(false) });
  // открытые заявки видит закупщик и склад (purchasing.manage / units.receive)
  const canSeeRequests = hasPerm(user, "purchasing.manage", "units.receive");
  const requests = useQuery({
    queryKey: ["purchase-requests", "open"],
    queryFn: () => listPurchaseRequests("open"),
    enabled: canSeeRequests,
  });
  const item = materials.data?.find((m) => m.item_id === itemId);
  const itemRequests = (requests.data ?? []).filter((r) => r.item_id != null && r.item_id === itemId);

  const save = useMutation({
    mutationFn: async (v: Values): Promise<unknown> => {
      const when = v.occurred_at ? v.occurred_at.format("YYYY-MM-DD") : null;
      return v.request_id
        ? receiveItemPurchaseRequest(v.request_id, {
            quantity: v.quantity,
            doc: v.doc || undefined,
            price: v.price ?? undefined,
            close: v.close ?? true,
            occurred_at: when,
          })
        : createMaterialMove({
            item_id: v.item_id,
            kind: "receipt",
            qty: v.quantity,
            doc: v.doc || null,
            price: v.price ?? null,
            occurred_at: when,
          });
    },
    onSuccess: (_, v) => {
      for (const k of ["material-stock", "material-moves", "material-demand", "purchase-requests", "unified-stock"]) qc.invalidateQueries({ queryKey: [k] });
      setLast(`${item?.name ?? "Материал"} — ${v.quantity} ${item?.unit ?? ""}${v.doc ? `, УПД ${v.doc}` : ""}`);
      message.success("Приход записан");
      form.resetFields(["item_id", "quantity", "price", "request_id"]);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось записать приход")),
  });

  return (
    <Form form={form} layout="vertical" initialValues={{ close: true }} onFinish={(v) => save.mutate(v)} style={{ maxWidth: 520 }}>
      <Form.Item name="item_id" label="Материал" rules={[{ required: true, message: "Выберите материал" }]}>
        <Select
          size="large"
          showSearch
          optionFilterProp="label"
          loading={materials.isLoading}
          placeholder="МДФ, пенопласт, клей…"
          onChange={() => form.setFieldValue("request_id", undefined)}
          options={(materials.data ?? []).map((m) => ({ value: m.item_id, label: `${m.name} (остаток ${Math.round(m.balance * 100) / 100} ${m.unit})` }))}
        />
      </Form.Item>
      {itemRequests.length > 0 && (
        <Form.Item name="request_id" label="По заявке на закупку (необязательно)">
          <Select
            size="large"
            allowClear
            placeholder="Эта поставка по заявке…"
            onChange={(id) => {
              const r = itemRequests.find((x) => x.id === id);
              if (r) form.setFieldsValue({ quantity: r.quantity ?? undefined, price: r.price_per_unit ?? undefined });
            }}
            options={itemRequests.map((r) => ({
              value: r.id,
              label: `№${r.id} — ${r.quantity} ${r.unit ?? ""}${r.supplier ? `, ${r.supplier}` : ""}${r.need_by ? `, к ${r.need_by.slice(8, 10)}.${r.need_by.slice(5, 7)}` : ""}`,
            }))}
          />
        </Form.Item>
      )}
      <Form.Item name="quantity" label={`Пришло${item ? `, ${item.unit}` : ""}`} rules={[{ required: true, message: "Сколько пришло" }]}>
        <InputNumber size="large" min={0.001} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item name="doc" label="УПД / накладная">
        <Input size="large" />
      </Form.Item>
      <Form.Item name="price" label={`Цена, ₽${item ? ` за ${item.unit}` : ""} (по УПД, необязательно)`}>
        <InputNumber size="large" min={0} style={{ width: "100%" }} />
      </Form.Item>
      {requestId && (
        <Form.Item name="close" valuePropName="checked">
          <Checkbox>Закрыть заявку (пришло всё)</Checkbox>
        </Form.Item>
      )}
      <OccurredAtField label="Дата прихода (необязательно — по умолчанию сейчас)" />
      <Button size="large" type="primary" htmlType="submit" block loading={save.isPending}>
        Записать приход
      </Button>
      {last && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          Последний приход: {last}
        </Typography.Paragraph>
      )}
    </Form>
  );
}
