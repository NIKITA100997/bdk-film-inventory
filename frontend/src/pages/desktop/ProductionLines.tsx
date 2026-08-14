import { useState } from "react";
import { Card, Tag, Button, Modal, Form, Input, Select, Space, Typography, DatePicker, Empty, Checkbox, message } from "antd";
import dayjs from "dayjs";
import ResponsiveTable from "../../components/ResponsiveTable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listProductionLines,
  createProductionLine,
  updateProductionLine,
  listProductionTasks,
  type ProductionLine,
  type ProductionLineUpdate,
} from "../../api/production";
import type { AreaValue } from "../../api/units";
import { listAreas } from "../../api/areas";

/** Линии цеха — вынесены из "Заданий цеха" в отдельный пункт меню (та же
 * причина, что у "Моделей продукции": список линий настраивают редко, не
 * каждый день). Плюс к прежней CRUD-таблице названий — просмотр текущей
 * загрузки: что распределено на линию на выбранную дату (раздел обратной
 * связи "не просто настройка названия, а... возможность посмотреть текущие
 * задания"). Данные для этого уже есть в distribution по строкам заданий
 * (ProductionTaskLineAssignment.line_id) — отдельного бэкенд-эндпоинта не
 * понадобилось, агрегируем на лету из уже загруженного списка заданий,
 * как и "План на день" в ProductionTasks.tsx. */
export default function ProductionLines() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<ProductionLine | null>(null);
  const [loadingLine, setLoadingLine] = useState<ProductionLine | null>(null);
  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs>(dayjs());
  const [form] = Form.useForm<{ name: string; area: string }>();
  const [editForm] = Form.useForm<ProductionLineUpdate>();
  const [showArchived, setShowArchived] = useState(false);

  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));

  const dateStr = selectedDate.format("YYYY-MM-DD");
  const assignmentsByLine = new Map<number, { taskName: string; partName: string; quantity: number; employees: string }[]>();
  for (const task of tasksQuery.data ?? []) {
    for (const line of task.lines) {
      for (const a of line.assignments ?? []) {
        if (a.date !== dateStr) continue;
        const rows = assignmentsByLine.get(a.line_id) ?? [];
        rows.push({
          taskName: task.product_model_name ?? task.name ?? `Задание №${task.id}`,
          partName: line.part_name ?? "—",
          quantity: a.quantity_pieces,
          employees: a.employee_names,
        });
        assignmentsByLine.set(a.line_id, rows);
      }
    }
  }
  const loadingRows = loadingLine ? assignmentsByLine.get(loadingLine.id) ?? [] : [];

  const createMutation = useMutation({
    mutationFn: createProductionLine,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-lines"] });
      setModalOpen(false);
      form.resetFields();
      message.success("Линия добавлена");
    },
    onError: () => message.error("Не удалось добавить — название уже занято?"),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ProductionLineUpdate }) => updateProductionLine(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-lines"] });
      setEditingLine(null);
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить — название уже занято?"),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Производственные линии"
        extra={
          <Space>
            <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
              Показывать архивные
            </Checkbox>
            <Button type="primary" onClick={() => setModalOpen(true)}>
              Добавить линию
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          Линия здесь называет и физическую линию окутки, и вид детали, который она обрабатывает («Поперечная-1» —
          и линия, и вид детали, пилот: окутка царговых).
        </Typography.Paragraph>
        <ResponsiveTable<ProductionLine>
          tableKey="production-lines"
          lockedColumns={["Название"]}
          rowKey="id"
          loading={linesQuery.isLoading}
          dataSource={(linesQuery.data ?? []).filter((l) => showArchived || l.is_active)}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Участок", dataIndex: "area", render: (v: string) => areaLabel(v) },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
            },
            {
              key: "loading",
              title: `Загрузка на ${selectedDate.format("DD.MM.YYYY")}`,
              render: (_, l) => {
                const rows = assignmentsByLine.get(l.id) ?? [];
                const total = rows.reduce((sum, r) => sum + r.quantity, 0);
                return (
                  <Button size="small" onClick={() => setLoadingLine(l)} disabled={rows.length === 0}>
                    {rows.length === 0 ? "пусто" : `${rows.length} задан. · ${total} шт`}
                  </Button>
                );
              },
            },
            {
              title: "",
              render: (_, l) => (
                <Space>
                  <Button size="small" onClick={() => { setEditingLine(l); editForm.setFieldsValue({ name: l.name, area: l.area }); }}>
                    Изменить
                  </Button>
                  <Button size="small" onClick={() => updateMutation.mutate({ id: l.id, payload: { is_active: !l.is_active } })}>
                    {l.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={loadingLine ? `Загрузка линии «${loadingLine.name}»` : ""}
        open={!!loadingLine}
        onCancel={() => setLoadingLine(null)}
        footer={[
          <Button key="close" onClick={() => setLoadingLine(null)}>
            Закрыть
          </Button>,
        ]}
      >
        <Space style={{ marginBottom: 12 }}>
          <Typography.Text>Дата:</Typography.Text>
          <DatePicker value={selectedDate} onChange={(d) => d && setSelectedDate(d)} format="DD.MM.YYYY" allowClear={false} />
        </Space>
        {loadingRows.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="На эту дату ничего не распределено" />
        ) : (
          <ResponsiveTable
            rowKey={(_: unknown, i?: number) => String(i)}
            size="small"
            dataSource={loadingRows}
            pagination={false}
            columns={[
              { title: "Задание", dataIndex: "taskName" },
              { title: "Деталь", dataIndex: "partName" },
              { title: "Кол-во, шт", dataIndex: "quantity" },
              { title: "Сотрудники", dataIndex: "employees" },
            ]}
          />
        )}
      </Modal>

      <Modal title="Новая линия" open={modalOpen} onCancel={() => setModalOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" form={form} onFinish={(v) => createMutation.mutate(v as { name: string; area: AreaValue })}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input placeholder="Поперечная-1" />
          </Form.Item>
          <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
            <Select options={areaOptions} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal title={`Изменить линию ${editingLine?.name ?? ""}`} open={!!editingLine} onCancel={() => setEditingLine(null)} footer={null} destroyOnHidden>
        <Form form={editForm} layout="vertical" onFinish={(v) => editingLine && updateMutation.mutate({ id: editingLine.id, payload: v })}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
            <Select options={areaOptions} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={updateMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
