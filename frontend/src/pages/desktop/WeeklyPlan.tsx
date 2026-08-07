import { useState } from "react";
import { Card, Form, DatePicker, Input, InputNumber, Button, Table, Tag, Space, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { createWeeklyPlan, addFilmRequestLine, getWeeklyPlan, listWeeklyPlans, type FilmRequestLineCreate } from "../../api/plans";

export default function WeeklyPlan() {
  const qc = useQueryClient();
  const [planId, setPlanId] = useState<number | null>(null);
  const [createForm] = Form.useForm();
  const [lineForm] = Form.useForm<FilmRequestLineCreate>();

  const plansQuery = useQuery({ queryKey: ["weekly-plans"], queryFn: listWeeklyPlans });
  const planQuery = useQuery({
    queryKey: ["weekly-plan", planId],
    queryFn: () => getWeeklyPlan(planId!),
    enabled: !!planId,
  });

  const createMutation = useMutation({
    mutationFn: createWeeklyPlan,
    onSuccess: (plan) => {
      setPlanId(plan.id);
      qc.invalidateQueries({ queryKey: ["weekly-plans"] });
      message.success("План создан");
    },
  });

  const addLineMutation = useMutation({
    mutationFn: (values: FilmRequestLineCreate) => addFilmRequestLine(planId!, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["weekly-plan", planId] });
      lineForm.resetFields();
      message.success("Позиция добавлена");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Недельный план">
        <Space wrap style={{ marginBottom: 16 }}>
          {(plansQuery.data ?? []).map((p) => (
            <Button key={p.id} type={p.id === planId ? "primary" : "default"} onClick={() => setPlanId(p.id)}>
              {p.week_start} — {p.week_end}
            </Button>
          ))}
        </Space>

        <Form
          form={createForm}
          layout="inline"
          onFinish={(v) =>
            createMutation.mutate({
              week_start: v.range[0].format("YYYY-MM-DD"),
              week_end: v.range[1].format("YYYY-MM-DD"),
            })
          }
        >
          <Form.Item name="range" rules={[{ required: true }]} initialValue={[dayjs(), dayjs().add(6, "day")]}>
            <DatePicker.RangePicker />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createMutation.isPending}>
            Новый план на неделю
          </Button>
        </Form>
      </Card>

      {planId && (
        <Card title={`Заявка на плёнку — план №${planId}`}>
          <Form form={lineForm} layout="inline" onFinish={(v) => addLineMutation.mutate(v)} style={{ marginBottom: 16 }}>
            <Form.Item name="material" rules={[{ required: true }]}>
              <Input placeholder="Материал" />
            </Form.Item>
            <Form.Item name="color" rules={[{ required: true }]}>
              <Input placeholder="Цвет" />
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

          <Table
            rowKey="id"
            loading={planQuery.isLoading}
            dataSource={planQuery.data?.lines ?? []}
            pagination={false}
            columns={[
              { title: "Материал", render: (_, l) => `${l.material}, ${l.color}, ${l.thickness} мм` },
              { title: "План, м²", dataIndex: "planned_area_m2" },
              { title: "Остаток, м²", dataIndex: "current_stock_m2" },
              {
                title: "Статус",
                render: (_, l) =>
                  l.shortage ? <Tag color="orange">Не хватает</Tag> : <Tag color="green">Хватает</Tag>,
              },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}
