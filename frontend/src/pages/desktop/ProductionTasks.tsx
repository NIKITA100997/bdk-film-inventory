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
  DatePicker,
  message,
} from "antd";
import dayjs from "dayjs";
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
  listTaskLineAssignments,
  createTaskLineAssignment,
  type ProductionLine,
  type ProductionLineUpdate,
  type ProductModel,
  type ProductModelPartCreate,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineManualCreate,
  type ProductionTaskLineAssignmentCreate,
} from "../../api/production";
import { listUsers } from "../../api/users";
import { listMaterialSkus } from "../../api/dictionaries";
import { WRITE_OFF_REASON_OPTIONS, skuLabel, type AreaValue, type MaterialSku, type WriteOffReasonValue } from "../../api/units";
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
type ManualRowFormValues = ProductionTaskLineManualCreate & { sku_id?: number };

function TasksTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const canReport = canManage || !!user?.permissions.includes("production_tasks.report");
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [manualLines, setManualLines] = useState<ProductionTaskLineManualCreate[]>([]);
  const [reportTarget, setReportTarget] = useState<{ taskId: number; line: ProductionTaskLine } | null>(null);
  const [defectRows, setDefectRows] = useState<{ reason: WriteOffReasonValue; qty: number; note?: string }[]>([]);
  const [assignTarget, setAssignTarget] = useState<{ task: ProductionTask; line: ProductionTaskLine } | null>(null);
  const [manualForm] = Form.useForm<{ name: string; area: AreaValue }>();
  const [manualRowForm] = Form.useForm<ManualRowFormValues>();
  const [bomForm] = Form.useForm<{ product_model_id: number; quantity: number; sku_id: number }>();
  const [reportForm] = Form.useForm<{ good_pieces: number }>();
  const [defectRowForm] = Form.useForm<{ reason: WriteOffReasonValue; qty: number; note?: string }>();
  const [assignForm] = Form.useForm<{ line_id: number; date: dayjs.Dayjs; employee_names: string; quantity_pieces: number }>();

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
  const usersQuery = useQuery({ queryKey: ["users-summary"], queryFn: listUsers });
  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;
  const skuOptions = (skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }));

  const activeModels = (modelsQuery.data ?? []).filter((m) => m.is_active && m.parts.length > 0);
  const bomProductModelId = Form.useWatch("product_model_id", bomForm);

  const tasks = (tasksQuery.data ?? []).filter((t) => !user?.area || t.area === user.area);

  const applySkuFields = (form: typeof manualRowForm, sku: MaterialSku | undefined) => {
    if (!sku) return;
    form.setFieldsValue({ material: sku.material.name, color: sku.color.name, thickness: sku.thickness.value_mm });
  };

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
      .then(({ product_model_id, quantity, sku_id }) => {
        const model = activeModels.find((m) => m.id === product_model_id);
        const sku = skusQuery.data?.find((s) => s.id === sku_id);
        if (!model || !sku) return;
        const loaded: ProductionTaskLineManualCreate[] = model.parts.map((p) => ({
          material: sku.material.name,
          color: sku.color.name,
          thickness: sku.thickness.value_mm,
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
        manualRowForm.setFieldsValue({ sku_id });
        applySkuFields(manualRowForm, sku);
      })
      .catch(() => {});
  };

  const addDefectRow = (v: { reason: WriteOffReasonValue; qty: number; note?: string }) => {
    setDefectRows((rows) => [...rows, v]);
    defectRowForm.resetFields();
  };
  const removeDefectRow = (index: number) => setDefectRows((rows) => rows.filter((_, i) => i !== index));

  const reportMutation = useMutation({
    // Раздел про несколько причин брака в одном отчёте — накопительный
    // журнал (ProductionTaskLineReport) уже это поддерживает: просто шлём
    // несколько строк вместо одной (хорошие детали отдельной строкой,
    // затем по одной строке на каждую причину брака), агрегаты суммируют
    // их на бэкенде так же, как если бы это были отчёты за разные смены.
    mutationFn: async () => {
      const good = reportForm.getFieldValue("good_pieces") ?? 0;
      const calls: Promise<unknown>[] = [];
      if (good > 0) {
        calls.push(createTaskLineReport(reportTarget!.taskId, reportTarget!.line.id, { good_pieces: good, defect_pieces: 0 }));
      }
      for (const row of defectRows) {
        calls.push(
          createTaskLineReport(reportTarget!.taskId, reportTarget!.line.id, {
            good_pieces: 0,
            defect_pieces: row.qty,
            defect_reason: row.reason,
            note: row.note,
          }),
        );
      }
      await Promise.all(calls);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      setReportTarget(null);
      reportForm.resetFields();
      setDefectRows([]);
      message.success("Отчёт сохранён");
    },
    onError: () => message.error("Не удалось сохранить отчёт"),
  });

  const assignmentsQuery = useQuery({
    queryKey: ["task-line-assignments", assignTarget?.task.id, assignTarget?.line.id],
    queryFn: () => listTaskLineAssignments(assignTarget!.task.id, assignTarget!.line.id),
    enabled: !!assignTarget,
  });
  const linesForAssignTask = (linesQuery.data ?? []).filter((l) => l.is_active && l.area === assignTarget?.task.area);
  const assignedSoFar = (assignmentsQuery.data ?? []).reduce((sum, a) => sum + a.quantity_pieces, 0);

  const assignMutation = useMutation({
    mutationFn: (v: ProductionTaskLineAssignmentCreate) => createTaskLineAssignment(assignTarget!.task.id, assignTarget!.line.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["task-line-assignments", assignTarget?.task.id, assignTarget?.line.id] });
      assignForm.resetFields();
      message.success("Распределение сохранено");
    },
    onError: () => message.error("Не удалось сохранить распределение"),
  });

  const addManualLine = (v: ManualRowFormValues) => {
    const { sku_id: _skuId, ...rest } = v;
    setManualLines((lines) => [...lines, rest]);
    const defaultSkuId = bomForm.getFieldValue("sku_id");
    manualRowForm.resetFields();
    if (defaultSkuId) {
      manualRowForm.setFieldsValue({ sku_id: defaultSkuId });
      applySkuFields(manualRowForm, skusQuery.data?.find((s) => s.id === defaultSkuId));
    }
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
                      title: "Распределено",
                      render: (_, l) => `${l.assigned_pieces} из ${l.quantity_pieces} шт`,
                    },
                    {
                      title: "",
                      render: (_, l) =>
                        canReport && (
                          <Space size={4}>
                            <Button size="small" onClick={() => setAssignTarget({ task, line: l })}>
                              Распределить
                            </Button>
                            <Button
                              size="small"
                              onClick={() => {
                                setReportTarget({ taskId: task.id, line: l });
                                reportForm.resetFields();
                                defectRowForm.resetFields();
                                setDefectRows([]);
                              }}
                            >
                              Отчитаться
                            </Button>
                          </Space>
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
          Строки задания — общий редактируемый список ниже: заполните их из состава модели (номенклатуру плёнки для
          состава выбираете здесь — в BOM цвет/материал не фиксируется) и/или добавьте вручную. Линия не выбирается
          здесь — задание ставится на участок, а по линиям/дням/сотрудникам его распределяет начальник участка
          отдельно (кнопка «Распределить» у уже созданного задания).
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
          <Form.Item name="sku_id" label="Материал (номенклатура)" rules={[{ required: true }]}>
            <Select showSearch placeholder="Выберите позицию материала" options={skuOptions} optionFilterProp="label" />
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
          <Form.Item name="sku_id" label="Материал (номенклатура)" rules={[{ required: true }]}>
            <Select
              showSearch
              placeholder="Выберите позицию материала"
              options={skuOptions}
              optionFilterProp="label"
              onChange={(skuId) => applySkuFields(manualRowForm, skusQuery.data?.find((s) => s.id === skuId))}
            />
          </Form.Item>
          <Form.Item name="material" hidden rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="color" hidden rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="thickness" hidden rules={[{ required: true }]}>
            <InputNumber />
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
        onCancel={() => {
          setReportTarget(null);
          setDefectRows([]);
        }}
        footer={null}
        destroyOnHidden
      >
        {reportTarget && (
          <>
            <Typography.Paragraph type="secondary">
              Нужно: {reportTarget.line.quantity_pieces} шт, уже произведено: {reportTarget.line.produced_good_pieces} шт,
              остаток: {reportTarget.line.remaining_pieces} шт.
            </Typography.Paragraph>
            <Form layout="vertical" form={reportForm}>
              <Form.Item name="good_pieces" label="Хороших деталей, шт" initialValue={0} rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Form>

            {defectRows.length > 0 && (
              <Table
                rowKey={(_, i) => String(i)}
                size="small"
                pagination={false}
                dataSource={defectRows}
                style={{ marginBottom: 16 }}
                columns={[
                  { title: "Причина брака", dataIndex: "reason" },
                  { title: "Кол-во, шт", dataIndex: "qty" },
                  { title: "Заметка", render: (_, r) => r.note ?? "—" },
                  {
                    title: "",
                    render: (_, __, index) => (
                      <Button size="small" danger onClick={() => removeDefectRow(index)}>
                        Убрать
                      </Button>
                    ),
                  },
                ]}
              />
            )}

            <Typography.Title level={5}>Добавить причину брака</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
              Брак может быть по нескольким причинам сразу — например, 1 деталь мусор под плёнкой, 2 деталь
              царапины: добавьте отдельную строку на каждую причину.
            </Typography.Paragraph>
            <Form form={defectRowForm} layout="vertical" onFinish={addDefectRow}>
              <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
                <Select options={WRITE_OFF_REASON_OPTIONS.map((r) => ({ value: r, label: r }))} />
              </Form.Item>
              <Form.Item name="qty" label="Количество, шт" rules={[{ required: true }]}>
                <InputNumber min={1} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="note" label="Заметка (опционально)">
                <Input placeholder="Например: мусор под плёнкой" />
              </Form.Item>
              <Button htmlType="submit" block>
                Добавить причину
              </Button>
            </Form>

            <Button
              type="primary"
              block
              style={{ marginTop: 16 }}
              loading={reportMutation.isPending}
              onClick={() => {
                reportForm
                  .validateFields()
                  .then((v) => {
                    if ((v.good_pieces ?? 0) <= 0 && defectRows.length === 0) {
                      message.warning("Укажите хотя бы хорошие детали или причину брака");
                      return;
                    }
                    reportMutation.mutate();
                  })
                  .catch(() => {});
              }}
            >
              Сохранить отчёт
            </Button>
          </>
        )}
      </Modal>

      <Modal
        title={assignTarget ? `Распределение строки «${assignTarget.line.part_name ?? assignTarget.line.material}»` : ""}
        open={!!assignTarget}
        onCancel={() => setAssignTarget(null)}
        footer={null}
        destroyOnHidden
      >
        {assignTarget && (
          <>
            <Typography.Paragraph type="secondary">
              Нужно всего: {assignTarget.line.quantity_pieces} шт. Распределено по линиям:{" "}
              <Typography.Text strong>{assignedSoFar}</Typography.Text> из {assignTarget.line.quantity_pieces} шт.
            </Typography.Paragraph>

            <Table
              rowKey="id"
              size="small"
              loading={assignmentsQuery.isLoading}
              dataSource={assignmentsQuery.data ?? []}
              pagination={false}
              locale={{ emptyText: "Пока не распределено ни по одной линии" }}
              style={{ marginBottom: 16 }}
              columns={[
                { title: "Линия", dataIndex: "line_name" },
                { title: "Дата", render: (_, a) => dayjs(a.date).format("DD.MM.YYYY") },
                { title: "Сотрудники", dataIndex: "employee_names" },
                { title: "Кол-во, шт", dataIndex: "quantity_pieces" },
              ]}
            />

            <Typography.Title level={5}>Добавить распределение</Typography.Title>
            <Form layout="vertical" form={assignForm} onFinish={(v) => assignMutation.mutate({ ...v, date: v.date.format("YYYY-MM-DD") })}>
              <Form.Item name="line_id" label="Линия" rules={[{ required: true }]}>
                <Select options={linesForAssignTask.map((l) => ({ value: l.id, label: l.name }))} />
              </Form.Item>
              <Form.Item name="date" label="Дата" rules={[{ required: true }]} initialValue={dayjs()}>
                <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
              </Form.Item>
              <Form.Item name="employee_names" label="Сотрудники" rules={[{ required: true }]}>
                <Input placeholder="Иванов, Петров" />
              </Form.Item>
              <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
                <InputNumber min={1} style={{ width: "100%" }} />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={assignMutation.isPending}>
                Добавить
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
    onError: () => message.error("Не удалось добавить деталь"),
  });
  const deletePartMutation = useMutation({
    mutationFn: (partId: number) => deleteProductModelPart(selectedModel!.id, partId),
    onSuccess: (_, partId) => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      setSelectedModel((m) => (m ? { ...m, parts: m.parts.filter((p) => p.id !== partId) } : m));
    },
  });

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
              { title: "Участок", dataIndex: "area", render: (v: string) => areaLabels[v] ?? v },
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

      <Modal
        title="Новая деталь BOM"
        open={partModalOpen}
        onCancel={() => setPartModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={partForm}
          initialValues={{ area: selectedModel?.area }}
          onFinish={(v) => addPartMutation.mutate(v)}
        >
          <Form.Item name="part_name" label="Название детали (опционально)">
            <Input placeholder="Верхняя царга" />
          </Form.Item>
          <Form.Item
            name="area"
            label="Участок"
            rules={[{ required: true }]}
            help="По умолчанию — участок модели, можно изменить, если эта деталь делается на другом участке"
          >
            <Select options={areaOptions} />
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
