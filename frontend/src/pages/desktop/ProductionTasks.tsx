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
  createProductionTaskManual,
  createTaskLineReport,
  type ProductionLine,
  type ProductionLineUpdate,
  type ProductModel,
  type ProductModelPartCreate,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineManualCreate,
  type ProductionTaskLineReportCreate,
} from "../../api/production";
import { listUsers } from "../../api/users";
import { WRITE_OFF_REASON_OPTIONS, type AreaValue, type WriteOffReasonValue } from "../../api/units";
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
  const canReport = canManage || !!user?.permissions.includes("production_tasks.report");
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [manualLines, setManualLines] = useState<ProductionTaskLineManualCreate[]>([]);
  const [reportTarget, setReportTarget] = useState<{ taskId: number; line: ProductionTaskLine } | null>(null);
  const [manualForm] = Form.useForm<{ name: string; area: AreaValue }>();
  const [manualRowForm] = Form.useForm<ProductionTaskLineManualCreate>();
  const [bomForm] = Form.useForm<{ product_model_id: number; quantity: number; color: string }>();
  const [reportForm] = Form.useForm<ProductionTaskLineReportCreate>();

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });
  const usersQuery = useQuery({ queryKey: ["users-summary"], queryFn: listUsers });
  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;
  const lineName = (id: number) => linesQuery.data?.find((l) => l.id === id)?.name ?? `#${id}`;

  const activeModels = (modelsQuery.data ?? []).filter((m) => m.is_active && m.parts.length > 0);
  const manualArea = Form.useWatch("area", manualForm);
  const linesForManualArea = (linesQuery.data ?? []).filter((l) => l.is_active && l.area === manualArea);
  const bomProductModelId = Form.useWatch("product_model_id", bomForm);

  const tasks = (tasksQuery.data ?? []).filter((t) => !user?.area || t.area === user.area);

  const closeTaskModal = () => {
    setTaskModalOpen(false);
    manualForm.resetFields();
    manualRowForm.resetFields();
    bomForm.resetFields();
    setManualLines([]);
  };

  const manualCreateMutation = useMutation({
    mutationFn: createProductionTaskManual,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      closeTaskModal();
      message.success("Задание создано");
    },
    onError: () => message.error("Не удалось создать задание"),
  });

  const loadLinesFromBom = () => {
    bomForm
      .validateFields()
      .then(({ product_model_id, quantity, color }) => {
        const model = activeModels.find((m) => m.id === product_model_id);
        if (!model) return;
        const loaded: ProductionTaskLineManualCreate[] = model.parts.map((p) => ({
          line_id: p.line_id,
          material: p.material,
          color,
          thickness: p.thickness,
          quantity_pieces: p.qty_per_unit * quantity,
          width_mm: p.width_mm,
          length_m: p.length_m,
          part_name: p.part_name ?? undefined,
        }));
        setManualLines((lines) => [...lines, ...loaded]);
        manualForm.setFieldsValue({
          name: manualForm.getFieldValue("name") || `${model.name} — ${quantity} шт`,
          area: model.area,
        });
      })
      .catch(() => {});
  };

  const reportMutation = useMutation({
    mutationFn: (v: ProductionTaskLineReportCreate) => createTaskLineReport(reportTarget!.taskId, reportTarget!.line.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      setReportTarget(null);
      reportForm.resetFields();
      message.success("Отчёт сохранён");
    },
    onError: () => message.error("Не удалось сохранить отчёт"),
  });

  const addManualLine = (v: ProductionTaskLineManualCreate) => {
    setManualLines((lines) => [...lines, v]);
    manualRowForm.resetFields();
  };
  const removeManualLine = (index: number) => setManualLines((lines) => lines.filter((_, i) => i !== index));

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        extra={
          canManage && (
            <Button type="primary" onClick={() => setTaskModalOpen(true)}>
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
                <Table<ProductionTaskLine>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={task.lines}
                  columns={[
                    { title: "Деталь", render: (_, l) => l.part_name ?? "—" },
                    { title: "Линия", dataIndex: "line_name" },
                    { title: "Материал", render: (_, l) => `${l.material}, ${l.color}, ${l.thickness} мм` },
                    { title: "Размер детали", render: (_, l) => `${l.width_mm} мм × ${l.length_m} м` },
                    { title: "Нужно, шт", dataIndex: "quantity_pieces" },
                    { title: "Произведено", dataIndex: "produced_good_pieces" },
                    { title: "Брак", dataIndex: "defect_pieces" },
                    {
                      title: "Осталось",
                      render: (_, l) => (
                        <Typography.Text strong={l.remaining_pieces > 0}>
                          {l.remaining_pieces} шт{l.remaining_pieces > 0 ? ` (${l.remaining_length_m} м)` : ""}
                        </Typography.Text>
                      ),
                    },
                    {
                      title: "",
                      render: (_, l) =>
                        canReport && (
                          <Button
                            size="small"
                            onClick={() => {
                              setReportTarget({ taskId: task.id, line: l });
                              reportForm.resetFields();
                            }}
                          >
                            Отчитаться
                          </Button>
                        ),
                    },
                  ]}
                />
              ),
            }}
            columns={[
              { title: "Модель", render: (_, t) => t.product_model_name ?? t.name ?? "—" },
              { title: "Участок", dataIndex: "area", render: (v: string) => areaLabels[v] ?? v },
              { title: "Количество", render: (_, t) => t.quantity ?? "—" },
              { title: "Автор", dataIndex: "created_by", render: (id: number) => userName(id) },
              { title: "Создано", dataIndex: "created_at", render: (v: string) => new Date(v).toLocaleString("ru-RU") },
            ]}
          />
        )}
      </Card>

      <Modal
        title="Новое производственное задание"
        open={taskModalOpen}
        onCancel={closeTaskModal}
        footer={null}
        destroyOnHidden
        width={640}
      >
        <Typography.Paragraph type="secondary">
          Строки задания — общий редактируемый список ниже: заполните их из состава модели (цвет и линию для
          состава выбираете здесь — в BOM это только предложение по умолчанию) и/или добавьте вручную. Одну деталь
          можно раздробить на несколько строк с разными линиями — уберите предложенную строку и добавьте вместо
          неё несколько своих с нужным распределением количества.
        </Typography.Paragraph>

        <Typography.Title level={5}>Начать из модели (BOM)</Typography.Title>
        <Form form={bomForm} layout="vertical">
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
          <Form.Item name="color" label="Цвет плёнки" rules={[{ required: true }]}>
            <DictAutoComplete kind="colors" />
          </Form.Item>
          <Button block disabled={!bomProductModelId} onClick={loadLinesFromBom}>
            Загрузить строки из состава
          </Button>
        </Form>

        <Typography.Title level={5} style={{ marginTop: 24 }}>
          Название и участок задания
        </Typography.Title>
        <Form layout="vertical" form={manualForm}>
          <Form.Item name="name" label="Название задания" rules={[{ required: true }]}>
            <Input placeholder="Партия 500 дверей" />
          </Form.Item>
          <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
            <Select options={areaOptions} />
          </Form.Item>
        </Form>

        {manualLines.length > 0 && (
          <Table
            rowKey={(_, i) => String(i)}
            size="small"
            pagination={false}
            dataSource={manualLines}
            style={{ marginBottom: 16 }}
            columns={[
              { title: "Деталь", render: (_, l) => l.part_name ?? "—" },
              { title: "Линия", render: (_, l) => lineName(l.line_id) },
              { title: "Материал", render: (_, l) => `${l.material}, ${l.color}, ${l.thickness} мм` },
              { title: "Размер детали", render: (_, l) => `${l.width_mm} мм × ${l.length_m} м` },
              { title: "Кол-во, шт", dataIndex: "quantity_pieces" },
              {
                title: "",
                render: (_, __, index) => (
                  <Button size="small" danger onClick={() => removeManualLine(index)}>
                    Убрать
                  </Button>
                ),
              },
            ]}
          />
        )}

        <Typography.Title level={5}>Добавить строку</Typography.Title>
        <Form form={manualRowForm} layout="vertical" onFinish={addManualLine}>
          <Form.Item name="part_name" label="Название детали (опционально)">
            <Input placeholder="Стоевая" />
          </Form.Item>
          <Form.Item name="line_id" label="Линия" rules={[{ required: true }]}>
            <Select
              disabled={!manualArea}
              placeholder={manualArea ? "Выберите линию" : "Сначала выберите участок выше"}
              options={linesForManualArea.map((l) => ({ value: l.id, label: l.name }))}
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
          <Form.Item name="width_mm" label="Ширина детали, мм" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="length_m" label="Длина детали, м" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={0.1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button htmlType="submit" block>
            Добавить строку в задание
          </Button>
        </Form>

        <Button
          type="primary"
          block
          style={{ marginTop: 16 }}
          disabled={manualLines.length === 0}
          loading={manualCreateMutation.isPending}
          onClick={() => {
            manualForm
              .validateFields()
              .then((v) =>
                manualCreateMutation.mutate({
                  ...v,
                  product_model_id: bomProductModelId || undefined,
                  quantity: bomForm.getFieldValue("quantity") || undefined,
                  lines: manualLines,
                }),
              )
              .catch(() => {});
          }}
        >
          Создать задание ({manualLines.length} строк(и))
        </Button>
      </Modal>

      <Modal
        title={reportTarget ? `Отчёт по линии «${reportTarget.line.line_name}»` : ""}
        open={!!reportTarget}
        onCancel={() => setReportTarget(null)}
        footer={null}
        destroyOnHidden
      >
        {reportTarget && (
          <>
            <Typography.Paragraph type="secondary">
              Нужно: {reportTarget.line.quantity_pieces} шт, уже произведено: {reportTarget.line.produced_good_pieces} шт,
              остаток: {reportTarget.line.remaining_pieces} шт.
            </Typography.Paragraph>
            <Form layout="vertical" form={reportForm} onFinish={(v) => reportMutation.mutate(v)}>
              <Form.Item name="good_pieces" label="Хороших деталей, шт" rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="defect_pieces" label="Брака, шт" initialValue={0} rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="defect_reason" label="Причина брака (если есть)">
                <Select
                  allowClear
                  options={WRITE_OFF_REASON_OPTIONS.map((r) => ({ value: r, label: r }))}
                />
              </Form.Item>
              <Form.Item name="note" label="Заметка (опционально)">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={reportMutation.isPending}>
                Сохранить отчёт
              </Button>
            </Form>
          </>
        )}
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
              { title: "Размер детали", render: (_, p) => `${p.width_mm} мм × ${p.length_m} м` },
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
          <Form.Item name="width_mm" label="Ширина детали, мм" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="length_m" label="Длина детали, м" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={0.1} style={{ width: "100%" }} />
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
