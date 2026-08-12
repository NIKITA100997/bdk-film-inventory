import { useState } from "react";
import {
  Card,
  Tabs,
  Table,
  Button,
  Tag,
  Space,
  Form,
  Input,
  InputNumber,
  Select,
  Modal,
  Typography,
  Empty,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listProductionLines,
  createProductionLine,
  updateProductionLine,
  listProductModels,
  createProductModel,
  updateProductModel,
  addProductModelPart,
  deleteProductModelPart,
  listProductionTasks,
  createProductionTask,
  type ProductionLine,
  type ProductionLineUpdate,
  type ProductModel,
  type ProductModelPartCreate,
  type ProductionTask,
} from "../../api/production";
import { listUsers } from "../../api/users";
import type { AreaValue } from "../../api/units";
import DictAutoComplete from "../../components/DictAutoComplete";
import { useAuth } from "../../auth/AuthContext";

const areaLabels: Record<string, string> = {
  okutka_tsargovykh: "Окутка царговых",
  shchitovye_dveri: "Щитовые двери",
  tselnolistovye_dveri: "Цельнолистовые двери",
};
const areaOptions = Object.entries(areaLabels).map(([value, label]) => ({ value, label }));

/** Задания — разбор «N штук модели X» на строки по производственным
 * линиям (пилот: окутка царговых). Начальник участка (есть свой user.area)
 * видит только задания своего участка — тот же принцип, что уже в
 * MaterialsExplorer/Overview для остальных area-скоупированных экранов. */
function TasksTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<{ product_model_id: number; quantity: number }>();

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const usersQuery = useQuery({ queryKey: ["users-summary"], queryFn: listUsers });
  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;

  const activeModels = (modelsQuery.data ?? []).filter((m) => m.is_active && m.parts.length > 0);

  const tasks = (tasksQuery.data ?? []).filter((t) => !user?.area || t.product_model_area === user.area);

  const createMutation = useMutation({
    mutationFn: createProductionTask,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      setCreateOpen(false);
      form.resetFields();
      message.success("Задание создано");
    },
    onError: () => message.error("Не удалось создать задание"),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        extra={
          canManage && (
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              Создать задание
            </Button>
          )
        }
      >
        {tasks.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              canManage
                ? "Заданий пока нет — создайте первое кнопкой выше"
                : "Заданий для вашего участка пока нет"
            }
          />
        ) : (
          <Table<ProductionTask>
            rowKey="id"
            loading={tasksQuery.isLoading}
            dataSource={tasks}
            pagination={{ pageSize: 20 }}
            scroll={{ x: "max-content" }}
            expandable={{
              expandedRowRender: (task) => (
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={task.lines}
                  columns={[
                    { title: "Линия", dataIndex: "line_name" },
                    { title: "Материал", render: (_, l) => `${l.material}, ${l.color}, ${l.thickness} мм` },
                    { title: "Количество, шт", dataIndex: "quantity_pieces" },
                  ]}
                />
              ),
            }}
            columns={[
              { title: "Модель", dataIndex: "product_model_name" },
              { title: "Участок", dataIndex: "product_model_area", render: (v: string) => areaLabels[v] ?? v },
              { title: "Количество", dataIndex: "quantity" },
              { title: "Автор", dataIndex: "created_by", render: (id: number) => userName(id) },
              { title: "Создано", dataIndex: "created_at", render: (v: string) => new Date(v).toLocaleString("ru-RU") },
            ]}
          />
        )}
      </Card>

      <Modal title="Новое производственное задание" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" form={form} onFinish={(v) => createMutation.mutate(v)}>
          <Form.Item name="product_model_id" label="Модель продукции" rules={[{ required: true }]}>
            <Select
              placeholder="Выберите модель"
              options={activeModels.map((m) => ({ value: m.id, label: `${m.name} (${areaLabels[m.area]})` }))}
              notFoundContent={<Typography.Text type="secondary">Нет моделей с заполненным BOM — заведите на вкладке «Модели продукции»</Typography.Text>}
            />
          </Form.Item>
          <Form.Item name="quantity" label="Количество, шт" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать и разбить по линиям
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}

function ModelsTab() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ProductModel | null>(null);
  const [partModalOpen, setPartModalOpen] = useState(false);
  const [form] = Form.useForm<{ name: string; area: string }>();
  const [partForm] = Form.useForm<ProductModelPartCreate>();

  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });

  const createMutation = useMutation({
    mutationFn: createProductModel,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      setCreateOpen(false);
      form.resetFields();
      message.success("Модель создана");
    },
    onError: () => message.error("Не удалось создать — название уже занято?"),
  });
  const archiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => updateProductModel(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-models"] }),
  });
  const addPartMutation = useMutation({
    mutationFn: (payload: ProductModelPartCreate) => addProductModelPart(selectedModel!.id, payload),
    onSuccess: (part) => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      setSelectedModel((m) => (m ? { ...m, parts: [...m.parts, part] } : m));
      setPartModalOpen(false);
      partForm.resetFields();
      message.success("Деталь добавлена");
    },
    onError: () => message.error("Не удалось добавить — линия с другого участка?"),
  });
  const deletePartMutation = useMutation({
    mutationFn: (partId: number) => deleteProductModelPart(selectedModel!.id, partId),
    onSuccess: (_, partId) => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      setSelectedModel((m) => (m ? { ...m, parts: m.parts.filter((p) => p.id !== partId) } : m));
    },
  });

  const linesForModelArea = (linesQuery.data ?? []).filter((l) => l.is_active && l.area === selectedModel?.area);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Модели продукции"
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            Добавить модель
          </Button>
        }
      >
        <Table<ProductModel>
          rowKey="id"
          loading={modelsQuery.isLoading}
          dataSource={modelsQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name", render: (v, m) => <a onClick={() => setSelectedModel(m)}>{v}</a> },
            { title: "Участок", dataIndex: "area", render: (v: string) => areaLabels[v] ?? v },
            { title: "Деталей в BOM", render: (_, m) => m.parts.length },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
            },
            {
              title: "",
              render: (_, m) => (
                <Button size="small" onClick={() => archiveMutation.mutate({ id: m.id, is_active: !m.is_active })}>
                  {m.is_active ? "В архив" : "Восстановить"}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {selectedModel && (
        <Card
          title={`BOM модели «${selectedModel.name}» (${areaLabels[selectedModel.area]})`}
          extra={
            <Button type="primary" onClick={() => setPartModalOpen(true)}>
              Добавить деталь
            </Button>
          }
        >
          <Table
            rowKey="id"
            dataSource={selectedModel.parts}
            pagination={false}
            columns={[
              { title: "Деталь", dataIndex: "part_name", render: (v: string | null) => v ?? "—" },
              { title: "Линия", dataIndex: "line_name" },
              { title: "Материал", render: (_, p) => `${p.material}, ${p.color}, ${p.thickness} мм` },
              { title: "Кол-во на единицу", dataIndex: "qty_per_unit" },
              {
                title: "",
                render: (_, p) => (
                  <Button size="small" danger onClick={() => deletePartMutation.mutate(p.id)}>
                    Удалить
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Modal title="Новая модель продукции" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" form={form} onFinish={(v) => createMutation.mutate(v as { name: string; area: AreaValue })}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input placeholder="Дверь царговая, Прованс" />
          </Form.Item>
          <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
            <Select options={areaOptions} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal title="Новая деталь BOM" open={partModalOpen} onCancel={() => setPartModalOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" form={partForm} onFinish={(v) => addPartMutation.mutate(v)}>
          <Form.Item name="part_name" label="Название детали (опционально)">
            <Input placeholder="Верхняя царга" />
          </Form.Item>
          <Form.Item name="line_id" label="Линия" rules={[{ required: true }]}>
            <Select
              options={linesForModelArea.map((l) => ({ value: l.id, label: l.name }))}
              notFoundContent={<Typography.Text type="secondary">Нет линий на этом участке — заведите на вкладке «Линии»</Typography.Text>}
            />
          </Form.Item>
          <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
            <DictAutoComplete kind="materials" />
          </Form.Item>
          <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
            <DictAutoComplete kind="colors" />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="qty_per_unit" label="Количество деталей на одну единицу модели" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={addPartMutation.isPending}>
            Добавить
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}

function LinesTab() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<ProductionLine | null>(null);
  const [form] = Form.useForm<{ name: string; area: string }>();
  const [editForm] = Form.useForm<ProductionLineUpdate>();

  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });

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
          <Button type="primary" onClick={() => setModalOpen(true)}>
            Добавить линию
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          Линия здесь называет и физическую линию окутки, и вид детали, который она обрабатывает («Поперечная-1» —
          и линия, и вид детали, пилот: окутка царговых).
        </Typography.Paragraph>
        <Table<ProductionLine>
          rowKey="id"
          loading={linesQuery.isLoading}
          dataSource={linesQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Участок", dataIndex: "area", render: (v: string) => areaLabels[v] ?? v },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
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

export default function ProductionTasks() {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");

  return (
    <Card>
      <Typography.Title level={4}>Производственные задания</Typography.Title>
      <Tabs
        items={[
          { key: "tasks", label: "Задания", children: <TasksTab /> },
          ...(canManage
            ? [
                { key: "models", label: "Модели продукции", children: <ModelsTab /> },
                { key: "lines", label: "Линии", children: <LinesTab /> },
              ]
            : []),
        ]}
      />
    </Card>
  );
}
