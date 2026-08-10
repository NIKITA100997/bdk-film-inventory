import { Card, Table, Form, Input, Button, Tag, Space, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listOrders, createOrder, closeOrder, type Order } from "../../api/orders";
import EmptyHint from "../../components/EmptyHint";

export default function Orders() {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ number: string }>();
  const ordersQuery = useQuery({ queryKey: ["orders"], queryFn: listOrders });

  const createMutation = useMutation({
    mutationFn: (values: { number: string }) => createOrder(values.number),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      form.resetFields();
      message.success("Заказ создан");
    },
    onError: () => message.error("Не удалось создать заказ — номер уже существует?"),
  });

  const closeMutation = useMutation({
    mutationFn: (id: number) => closeOrder(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      message.success("Заказ закрыт");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Заказы">
        <Form form={form} layout="inline" onFinish={(v) => createMutation.mutate(v)} style={{ marginBottom: 16 }}>
          <Form.Item name="number" rules={[{ required: true }]}>
            <Input placeholder="Номер заказа" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>

        <Table<Order>
          rowKey="id"
          loading={ordersQuery.isLoading}
          dataSource={ordersQuery.data ?? []}
          pagination={{ pageSize: 20 }}
          locale={{ emptyText: <EmptyHint description="Заказов пока нет — создайте первый выше" /> }}
          columns={[
            { title: "Номер", dataIndex: "number" },
            {
              title: "Статус",
              render: (_, o) => (o.status === "closed" ? <Tag>Закрыт</Tag> : <Tag color="green">Открыт</Tag>),
            },
            {
              title: "",
              render: (_, o) =>
                o.status !== "closed" && (
                  <Button size="small" onClick={() => closeMutation.mutate(o.id)} loading={closeMutation.isPending}>
                    Закрыть заказ
                  </Button>
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
