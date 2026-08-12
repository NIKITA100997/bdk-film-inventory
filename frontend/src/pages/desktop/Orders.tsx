import { useState } from "react";
import { Card, Table, Form, Input, InputNumber, Button, Tag, Space, Progress, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listOrders,
  getOrder,
  createOrder,
  addOrderLine,
  closeOrder,
  type Order,
  type OrderLine,
  type OrderLineCreate,
} from "../../api/orders";
import DictAutoComplete from "../../components/DictAutoComplete";
import EmptyHint from "../../components/EmptyHint";
import { useAuth } from "../../auth/AuthContext";
import { useDraftForm } from "../../hooks/useDraftForm";

/** Заказы (4 раздел обратной связи) — заказ теперь единица планирования:
 * свои строки потребности в материале и план/факт по нему самому, вместо
 * отдельного недельного плана. Сводный отчёт по всем заказам — во вкладке
 * "По заказам" в "Отчётах".
 *
 * Один и тот же экран даёт разный набор действий в зависимости от роли
 * (orders.manage — создание, orders.plan — строки потребности, orders.close
 * — закрытие) — по итогам продуктового разбора кнопки/формы скрываются по
 * фактическому праву, а не просто отрисовываются всем: раньше, например,
 * начальник цеха (только orders.plan) видел кнопку "Создать заказ" и получал
 * 403 при клике с сообщением "номер уже существует?", хотя дело было не в
 * номере, а в отсутствии права. */
export default function Orders() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const has = (permission: string) => !!user?.is_superuser || !!user?.permissions.includes(permission);
  const canManage = has("orders.manage");
  const canPlan = has("orders.plan");
  const canClose = has("orders.close");
  const [orderId, setOrderId] = useState<number | null>(null);
  const [createForm] = Form.useForm<{ number: string }>();
  const [lineForm] = Form.useForm<OrderLineCreate>();
  const lineDraft = useDraftForm(`draft:order-line:${orderId ?? "none"}`, lineForm);

  const ordersQuery = useQuery({ queryKey: ["orders"], queryFn: listOrders });
  const orderQuery = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => getOrder(orderId!),
    enabled: !!orderId,
  });

  const createMutation = useMutation({
    mutationFn: (values: { number: string }) => createOrder(values.number),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      setOrderId(order.id);
      createForm.resetFields();
      message.success("Заказ создан");
    },
    onError: () => message.error("Не удалось создать заказ — номер уже существует?"),
  });

  const addLineMutation = useMutation({
    mutationFn: (values: OrderLineCreate) => addOrderLine(orderId!, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order", orderId] });
      lineForm.resetFields();
      lineDraft.clearDraft();
      message.success("Позиция добавлена");
    },
  });

  const closeMutation = useMutation({
    mutationFn: (id: number) => closeOrder(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order", orderId] });
      message.success("Заказ закрыт");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Заказы">
        {!canManage && !canPlan && !canClose && (
          <Typography.Paragraph type="secondary">Доступен только просмотр — создание, строки потребности и закрытие вам не назначены.</Typography.Paragraph>
        )}
        {canManage && (
          <Form form={createForm} layout="inline" onFinish={(v) => createMutation.mutate(v)} style={{ marginBottom: 16 }}>
            <Form.Item name="number" rules={[{ required: true }]}>
              <Input placeholder="Номер заказа" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={createMutation.isPending}>
              Создать
            </Button>
          </Form>
        )}

        <Table<Order>
          rowKey="id"
          loading={ordersQuery.isLoading}
          dataSource={ordersQuery.data ?? []}
          pagination={{ pageSize: 20 }}
          scroll={{ x: "max-content" }}
          onRow={(o) => ({ onClick: () => setOrderId(o.id), style: { cursor: "pointer" } })}
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
                canClose && o.status !== "closed" && (
                  <Button
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeMutation.mutate(o.id);
                    }}
                    loading={closeMutation.isPending}
                  >
                    Закрыть заказ
                  </Button>
                ),
            },
          ]}
        />
      </Card>

      {orderId && (
        <Card title={`Заказ №${orderQuery.data?.number ?? ""} — потребность в материале и план/факт`} loading={orderQuery.isLoading}>
          {canPlan && (
            <Form
              form={lineForm}
              layout="inline"
              onFinish={(v) => addLineMutation.mutate(v)}
              onValuesChange={lineDraft.handleValuesChange}
              style={{ marginBottom: 16 }}
            >
              <Form.Item name="material" rules={[{ required: true }]}>
                <DictAutoComplete kind="materials" placeholder="Материал" />
              </Form.Item>
              <Form.Item name="color" rules={[{ required: true }]}>
                <DictAutoComplete kind="colors" placeholder="Цвет" />
              </Form.Item>
              <Form.Item name="thickness" rules={[{ required: true }]}>
                <InputNumber placeholder="Толщина, мм" min={0} step={0.01} />
              </Form.Item>
              <Form.Item name="planned_area_m2" rules={[{ required: true }]}>
                <InputNumber placeholder="Плановая площадь, м²" min={0} />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={addLineMutation.isPending}>
                Добавить позицию
              </Button>
            </Form>
          )}

          <Table<OrderLine>
            rowKey="id"
            dataSource={orderQuery.data?.lines ?? []}
            pagination={false}
            scroll={{ x: "max-content" }}
            locale={{ emptyText: <EmptyHint description="Позиций пока нет — добавьте потребность в материале выше" /> }}
            columns={[
              { title: "Материал", render: (_, l) => `${l.material}, ${l.color}, ${l.thickness} мм` },
              { title: "План, м²", dataIndex: "planned_area_m2" },
              { title: "Факт, м²", dataIndex: "actual_area_m2" },
              {
                title: "% выполнения",
                render: (_, l) => (
                  <Progress percent={Math.min(l.percent_complete, 100)} status={l.percent_complete >= 100 ? "success" : "active"} />
                ),
              },
              { title: "Остаток на складе, м²", dataIndex: "current_stock_m2" },
              {
                title: "Статус",
                render: (_, l) => (l.shortage ? <Tag color="orange">Не хватает</Tag> : <Tag color="green">Хватает</Tag>),
              },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}
