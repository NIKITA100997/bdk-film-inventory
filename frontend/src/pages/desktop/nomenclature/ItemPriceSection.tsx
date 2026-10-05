import { useState } from "react";
import { Button, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addItemPrice,
  deleteItemPrice,
  fmtMoney,
  getItemPrices,
  listCurrencies,
  setPriceSettings,
  type ItemPrice,
} from "../../../api/prices";
import { apiErrorMessage } from "../../../utils/apiError";
import { fmtDate } from "../../../utils/dates";
import { SectionHead } from "./ItemOverview";

const SOURCE_COLOR: Record<string, string> = { manual: "default", "1c": "blue", upd: "green" };

/** Цена позиции в карточке (05.10): действующая цена в своей валюте и в
 * рублях по курсу, условная единица цены (валюта, за что), история —
 * вручную, из 1С, по УПД. */
export default function ItemPriceSection({ itemId, kindCode, canManage }: { itemId: number; kindCode: string; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["item-prices", itemId], queryFn: () => getItemPrices(itemId) });
  const curQ = useQuery({ queryKey: ["currencies"], queryFn: listCurrencies });
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ price: number; currency: string; unit: string; valid_from: Dayjs; doc?: string; note?: string }>();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["item-prices", itemId] });
    qc.invalidateQueries({ queryKey: ["prices"] });
  };
  const add = useMutation({
    mutationFn: (v: { price: number; currency: string; unit: string; valid_from: Dayjs; doc?: string; note?: string }) =>
      addItemPrice(itemId, { ...v, valid_from: v.valid_from.format("YYYY-MM-DD") }),
    onSuccess: () => {
      invalidate();
      setOpen(false);
      message.success("Цена сохранена");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить цену")),
  });
  const del = useMutation({
    mutationFn: deleteItemPrice,
    onSuccess: invalidate,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить цену")),
  });
  const settings = useMutation({
    mutationFn: (s: { currency?: string; unit?: string }) => setPriceSettings(itemId, s),
    onSuccess: invalidate,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const d = q.data;
  const currencyOptions = (curQ.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.symbol})` }));
  const unitOptions = kindCode === "plenka" ? ["м²", "м"] : [d?.unit ?? "шт"];

  return (
    <section>
      <SectionHead
        title="Цена"
        action={
          canManage && (
            <Button
              size="small"
              onClick={() => {
                form.setFieldsValue({ price: undefined, currency: d?.currency ?? "RUB", unit: d?.unit, valid_from: dayjs(), doc: "", note: "" });
                setOpen(true);
              }}
            >
              Новая цена
            </Button>
          )
        }
      />
      {d && (
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Space wrap size={[16, 4]}>
            <Typography.Text>
              Действующая:{" "}
              {d.current ? (
                <>
                  <b>
                    {fmtMoney(d.current.price, d.current.currency)} за {d.current.unit}
                  </b>
                  {d.current.currency !== "RUB" && (
                    <Typography.Text type="secondary">
                      {" "}
                      = {d.current.rub != null ? `${fmtMoney(d.current.rub)}` : "курс не задан"}
                    </Typography.Text>
                  )}
                  <Typography.Text type="secondary">
                    {" "}
                    · {d.current.source_name}, с {fmtDate(d.current.valid_from)}
                  </Typography.Text>
                </>
              ) : (
                <Typography.Text type="secondary">не задана</Typography.Text>
              )}
            </Typography.Text>
          </Space>
          <Space wrap size={8}>
            <Typography.Text type="secondary">Цена ведётся в</Typography.Text>
            <Select
              size="small"
              style={{ width: 150 }}
              disabled={!canManage}
              value={d.currency}
              options={currencyOptions}
              onChange={(v) => settings.mutate({ currency: v })}
            />
            <Typography.Text type="secondary">за</Typography.Text>
            <Select
              size="small"
              style={{ width: 80 }}
              disabled={!canManage || unitOptions.length < 2}
              value={d.unit}
              options={unitOptions.map((u) => ({ value: u, label: u }))}
              onChange={(v) => settings.mutate({ unit: v })}
            />
          </Space>
          {d.history.length > 0 && (
            <Table<ItemPrice>
              size="small"
              rowKey="id"
              pagination={d.history.length > 8 ? { pageSize: 8 } : false}
              dataSource={d.history}
              columns={[
                { title: "С даты", render: (_, p) => fmtDate(p.valid_from) },
                { title: "Цена", render: (_, p) => `${fmtMoney(p.price, p.currency)} / ${p.unit}` },
                { title: "В рублях", render: (_, p) => (p.currency === "RUB" ? "" : fmtMoney(p.rub)) },
                { title: "Откуда", render: (_, p) => <Tag color={SOURCE_COLOR[p.source]}>{p.source_name}</Tag> },
                { title: "Документ", render: (_, p) => p.doc ?? p.note ?? "" },
                ...(canManage
                  ? [
                      {
                        title: "",
                        render: (_: unknown, p: ItemPrice) => (
                          <Popconfirm title="Удалить эту цену?" onConfirm={() => del.mutate(p.id)}>
                            <Button size="small" type="link" danger>
                              Удалить
                            </Button>
                          </Popconfirm>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </Space>
      )}
      <Modal title="Новая цена" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={add.isPending} okText="Сохранить" destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => add.mutate(v)}>
          <Space align="start">
            <Form.Item name="price" label="Цена" rules={[{ required: true, message: "Укажите цену" }]}>
              <InputNumber min={0} step={0.01} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="currency" label="Валюта">
              <Select style={{ width: 150 }} options={currencyOptions} />
            </Form.Item>
            <Form.Item name="unit" label="За">
              <Select style={{ width: 80 }} options={unitOptions.map((u) => ({ value: u, label: u }))} />
            </Form.Item>
          </Space>
          <Form.Item name="valid_from" label="Действует с">
            <DatePicker format="DD.MM.YYYY" allowClear={false} />
          </Form.Item>
          <Form.Item name="note" label="Комментарий">
            <Input placeholder="например: прайс поставщика от 01.10" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}
