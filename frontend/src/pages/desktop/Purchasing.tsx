import { useState } from "react";
import { Card, Table, Tag, Button, Modal, Form, InputNumber, Input, Space, Typography, Empty, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listShortages, type OrderShortageLine } from "../../api/orders";
import {
  listPurchaseRequests,
  createPurchaseRequest,
  closePurchaseRequest,
  type PurchaseRequest,
  type PurchaseRequestCreate,
} from "../../api/purchasing";
import DictAutoComplete from "../../components/DictAutoComplete";
import { getCalcSettings } from "../../api/abc";

export default function Purchasing() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<Partial<PurchaseRequestCreate> | null>(null);
  const [form] = Form.useForm<PurchaseRequestCreate>();

  const shortagesQuery = useQuery({ queryKey: ["order-shortages"], queryFn: listShortages });
  const requestsQuery = useQuery({ queryKey: ["purchase-requests"], queryFn: () => listPurchaseRequests() });
  const calcSettingsQuery = useQuery({ queryKey: ["calc-settings"], queryFn: getCalcSettings });

  const shortages = shortagesQuery.data ?? [];

  const createMutation = useMutation({
    mutationFn: createPurchaseRequest,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      setCreateOpen(false);
      form.resetFields();
      message.success("Заявка создана");
    },
    onError: () => message.error("Не удалось создать заявку"),
  });

  const closeMutation = useMutation({
    mutationFn: (id: number) => closePurchaseRequest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      message.success("Заявка закрыта");
    },
    onError: () => message.error("Не удалось закрыть заявку"),
  });

  const openFromShortage = (line: OrderShortageLine) => {
    const shortageM2 = Math.round((line.planned_area_m2 - line.current_stock_m2) * 100) / 100;
    const template = calcSettingsQuery.data?.shortage_note_template;
    const note = template
      ? template
          .replace("{material}", line.material)
          .replace("{color}", line.color)
          .replace("{thickness}", String(line.thickness))
          .replace("{shortage_m2}", String(shortageM2))
      : undefined;
    setPrefill({
      material: line.material,
      color: line.color,
      thickness: line.thickness,
      requested_area_m2: shortageM2,
      note,
    });
    setCreateOpen(true);
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Сигналы нехватки" loading={shortagesQuery.isLoading}>
        <Typography.Paragraph type="secondary">
          Строки потребности всех открытых заказов, где остаток на складе меньше плановой потребности (2.7 ТЗ, 4
          раздел обратной связи — источник теперь заказы, не «последний недельный план»).
        </Typography.Paragraph>
        {shortages.length === 0 ? (
          <Empty description="Нехватки не обнаружены" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table<OrderShortageLine>
            rowKey="line_id"
            size="small"
            pagination={false}
            dataSource={shortages}
            columns={[
              { title: "Заказ", dataIndex: "order_number" },
              { title: "Материал", render: (_, l) => `${l.material}, ${l.color}, ${l.thickness} мм` },
              { title: "План, м²", dataIndex: "planned_area_m2" },
              { title: "Остаток, м²", dataIndex: "current_stock_m2" },
              {
                title: "",
                render: (_, l) => (
                  <Button size="small" type="primary" onClick={() => openFromShortage(l)}>
                    Создать заявку
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="Заявки поставщику — история закупок"
        extra={
          <Button
            type="primary"
            onClick={() => {
              setPrefill(null);
              setCreateOpen(true);
            }}
          >
            Новая заявка
          </Button>
        }
      >
        <Table<PurchaseRequest>
          rowKey="id"
          loading={requestsQuery.isLoading}
          dataSource={requestsQuery.data ?? []}
          pagination={{ pageSize: 20 }}
          columns={[
            { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
            { title: "Запрошено, м²", dataIndex: "requested_area_m2" },
            { title: "Остаток на складе, м²", dataIndex: "current_stock_m2" },
            { title: "Комментарий", dataIndex: "note", render: (v: string | null) => v ?? "—" },
            {
              title: "Статус",
              dataIndex: "status",
              render: (v: string) => (v === "open" ? <Tag color="orange">Открыта</Tag> : <Tag color="green">Закрыта</Tag>),
            },
            {
              title: "Создана",
              dataIndex: "created_at",
              render: (v: string) => new Date(v).toLocaleDateString("ru-RU"),
            },
            {
              title: "",
              render: (_, r) =>
                r.status === "open" && (
                  <Button size="small" loading={closeMutation.isPending} onClick={() => closeMutation.mutate(r.id)}>
                    Закрыть вручную
                  </Button>
                ),
            },
          ]}
        />
      </Card>

      <Modal
        title="Новая заявка поставщику"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={form}
          initialValues={prefill ?? undefined}
          onFinish={(v) => createMutation.mutate(v)}
        >
          <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
            <DictAutoComplete kind="materials" />
          </Form.Item>
          <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
            <DictAutoComplete kind="colors" />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="requested_area_m2" label="Запросить, м²" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="note" label="Комментарий (номер заказа поставщику и т.п.)">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать заявку
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
