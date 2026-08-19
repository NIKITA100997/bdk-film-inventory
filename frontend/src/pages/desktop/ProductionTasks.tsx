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
  Checkbox,
  Upload,
  message,
} from "antd";
import dayjs from "dayjs";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}
import {
  listProductionLines,
  listProductModels,
  deleteProductionTask,
  archiveProductionTask,
  listProductionTasks,
  createProductionTaskManual,
  createTaskLineReport,
  listTaskLineAssignments,
  createTaskLineAssignment,
  parseNaryadFile,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineManualCreate,
  type ProductionTaskLineAssignmentCreate,
} from "../../api/production";
import { listUsers } from "../../api/users";
import { listMaterialSkus } from "../../api/dictionaries";
import { skuLabel, type AreaValue, type MaterialSku } from "../../api/units";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import { listAreas } from "../../api/areas";
import { useAuth } from "../../auth/AuthContext";

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
  const [assignTarget, setAssignTarget] = useState<{ task: ProductionTask; line: ProductionTaskLine } | null>(null);
  const [manualForm] = Form.useForm<{ name: string; area: AreaValue }>();
  const [manualRowForm] = Form.useForm<ManualRowFormValues>();
  const [bomForm] = Form.useForm<{ product_model_id: number; quantity: number }>();
  const [assignForm] = Form.useForm<{ line_id: number; date: dayjs.Dayjs; employee_names: string; quantity_pieces: number }>();
  // Общий выбор номенклатуры для обоих способов массовой загрузки строк
  // (из состава модели и из наряд-заказа) — раньше каждый способ таскал
  // свою копию одного и того же поля "Материал (номенклатура)", хотя оба
  // означают один и тот же выбор: какую плёнку подставить в загружаемые
  // строки (ни BOM, ни файл наряд-заказа плёнку не знают, только форму
  // деталей). "Добавить строку вручную" ниже — отдельный, самостоятельный
  // выбор (там материал реально может отличаться от строки к строке).
  const [selectedSkuId, setSelectedSkuId] = useState<number>();
  const [showArchived, setShowArchived] = useState(false);

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
  const usersQuery = useQuery({ queryKey: ["users-summary"], queryFn: listUsers });
  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;
  const skuOptions = (skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }));
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));

  const activeModels = (modelsQuery.data ?? []).filter((m) => m.is_active && m.parts.length > 0);
  const bomProductModelId = Form.useWatch("product_model_id", bomForm);

  const tasks = (tasksQuery.data ?? [])
    .filter((t) => !user?.area || t.area === user.area)
    .filter((t) => showArchived || t.is_active);

  const applySkuFields = (form: typeof manualRowForm, sku: MaterialSku | undefined) => {
    if (!sku) return;
    form.setFieldsValue({ material: sku.material.name, color: sku.color.name, thickness: sku.thickness.value_mm });
  };

  const closeTaskModal = () => {
    setTaskModalOpen(false);
    manualForm.resetFields();
    manualRowForm.resetFields();
    bomForm.resetFields();
    setSelectedSkuId(undefined);
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
    if (!selectedSkuId) return;
    bomForm
      .validateFields()
      .then(({ product_model_id, quantity }) => {
        const model = activeModels.find((m) => m.id === product_model_id);
        const sku = skusQuery.data?.find((s) => s.id === selectedSkuId);
        if (!model || !sku) return;
        const loaded: ProductionTaskLineManualCreate[] = model.parts.map((p) => ({
          material: sku.material.name,
          color: sku.color.name,
          thickness: sku.thickness.value_mm,
          quantity_pieces: p.qty_per_unit * quantity,
          width_mm: p.width_mm,
          length_m: p.length_m,
          strip_width_mm: p.strip_width_mm ?? undefined,
          part_name: p.part_name ?? undefined,
        }));
        setManualLines((lines) => [...lines, ...loaded]);
        manualForm.setFieldsValue({
          name: manualForm.getFieldValue("name") || `${model.name} — ${quantity} шт`,
          area: model.area,
        });
        manualRowForm.setFieldsValue({ sku_id: selectedSkuId });
        applySkuFields(manualRowForm, sku);
      })
      .catch(() => {});
  };

  // Раздел про загрузку наряд-заказа — печатная форма («Перечень деталей
  // столярных изделий») даёт только форму деталей, без плёнки: тот же
  // sku_id, что выбран здесь, подставляется в material/color/thickness
  // каждой распознанной строки, ровно как loadLinesFromBom подставляет
  // его для строк из состава модели.
  const parseNaryadMutation = useMutation({
    mutationFn: parseNaryadFile,
    onSuccess: (result) => {
      const sku = skusQuery.data?.find((s) => s.id === selectedSkuId);
      if (!sku) return;
      const loaded: ProductionTaskLineManualCreate[] = result.lines.map((l) => ({
        material: sku.material.name,
        color: sku.color.name,
        thickness: sku.thickness.value_mm,
        quantity_pieces: l.quantity_pieces,
        width_mm: l.width_mm,
        length_m: l.length_m,
        strip_width_mm: l.strip_width_mm ?? undefined,
        part_name: l.part_name,
      }));
      setManualLines((lines) => [...lines, ...loaded]);
      manualForm.setFieldsValue({ name: manualForm.getFieldValue("name") || result.suggested_name });
      message.success(`Из наряд-заказа добавлено строк: ${loaded.length}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось разобрать файл наряд-заказа")),
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

  const deleteTaskMutation = useMutation({
    mutationFn: (id: number) => deleteProductionTask(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success(result.requested ? "Заявка на удаление отправлена администратору" : "Задание удалено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить задание")),
  });

  const archiveTaskMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => archiveProductionTask(id, isActive),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success("Сохранено");
    },
  });

  const addManualLine = (v: ManualRowFormValues) => {
    const { sku_id: _skuId, ...rest } = v;
    setManualLines((lines) => [...lines, rest]);
    const defaultSkuId = selectedSkuId;
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
          <Space>
            <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
              Показывать архивные
            </Checkbox>
            {canManage && (
              <Button type="primary" onClick={() => setTaskModalOpen(true)}>
                Создать задание
              </Button>
            )}
          </Space>
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
              expandedRowRender: (task) => {
                // Раздел про общий погонаж на задание — итог по плёнке
                // (обычно одна на всё задание, но строки технически могут
                // различаться, поэтому группируем, а не берём одну сумму
                // вслепую) и общий остаток на довыдачу по заданию сразу.
                const bySku = new Map<string, { label: string; totalM: number; shortfallM: number }>();
                for (const l of task.lines) {
                  const key = `${l.material}|${l.color}|${l.thickness}`;
                  const entry = bySku.get(key) ?? { label: `${l.material}, ${l.color}, ${l.thickness} мм`, totalM: 0, shortfallM: 0 };
                  entry.totalM += l.quantity_pieces * l.length_m;
                  entry.shortfallM += l.shortfall_length_m;
                  bySku.set(key, entry);
                }
                return (
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <Space wrap size={[16, 4]}>
                      {[...bySku.values()].map((e) => (
                        <Typography.Text key={e.label}>
                          <strong>{e.label}</strong> — всего на задание {e.totalM.toFixed(2)} м
                          {e.shortfallM > 0 && <>, ещё выдать {e.shortfallM.toFixed(2)} м</>}
                        </Typography.Text>
                      ))}
                    </Space>
                    <Table<ProductionTaskLine>
                      rowKey="id"
                      size="small"
                      pagination={false}
                      dataSource={task.lines}
                      scroll={{ x: "max-content" }}
                      columns={[
                    { title: "Деталь", render: (_, l) => l.part_name ?? "—" },
                    { title: "Линия", dataIndex: "line_name" },
                    { title: "Материал", render: (_, l) => `${l.material}, ${l.color}, ${l.thickness} мм` },
                    { title: "Размер детали", render: (_, l) => `${l.width_mm} мм × ${l.length_m} м` },
                    { title: "Нужно, шт", dataIndex: "quantity_pieces" },
                    {
                      // Раздел про общий погонаж на задание — раньше видно
                      // было только расход на одну деталь ("Размер детали"),
                      // не на всю строку сразу.
                      title: "Погонаж на строку, м",
                      render: (_, l) => (l.quantity_pieces * l.length_m).toFixed(2),
                    },
                    { title: "Произведено", dataIndex: "produced_good_pieces" },
                    { title: "Брак", dataIndex: "defect_pieces" },
                    {
                      title: "Осталось произвести",
                      render: (_, l) => (
                        <Typography.Text strong={l.remaining_pieces > 0}>
                          {l.remaining_pieces} шт{l.remaining_pieces > 0 ? ` (${l.remaining_length_m} м)` : ""}
                        </Typography.Text>
                      ),
                    },
                    {
                      // shortfall_length_m — сколько плёнки ещё не выдано
                      // (не то же самое, что "осталось произвести": выдано
                      // может быть уже достаточно, даже если производство
                      // ещё не отчиталось, см. Issue.tsx "довыдать").
                      title: "Ещё выдать, м",
                      render: (_, l) => (
                        <Typography.Text type={l.shortfall_length_m > 0 ? "warning" : "secondary"}>
                          {l.shortfall_length_m > 0 ? l.shortfall_length_m.toFixed(2) : "выдано достаточно"}
                        </Typography.Text>
                      ),
                    },
                    {
                      title: "Распределено",
                      render: (_, l) => `${l.assigned_pieces} из ${l.quantity_pieces} шт`,
                    },
                    {
                      title: "Действия мастера",
                      render: (_, l) =>
                        canReport && (
                          <Space size={4}>
                            <Button size="small" type="primary" ghost onClick={() => setAssignTarget({ task, line: l })}>
                              📅 Распределить по дням
                            </Button>
                            <Button size="small" onClick={() => setReportTarget({ taskId: task.id, line: l })}>
                              Отчитаться о производстве
                            </Button>
                          </Space>
                        ),
                    },
                      ]}
                    />
                  </Space>
                );
              },
            }}
            columns={[
              { title: "Модель", render: (_, t) => t.product_model_name ?? t.name ?? "—" },
              { title: "Участок", dataIndex: "area", render: (v: string) => areaLabel(v) },
              { title: "Количество", render: (_, t) => t.quantity ?? "—" },
              { title: "Автор", dataIndex: "created_by", render: (id: number) => userName(id) },
              { title: "Создано", dataIndex: "created_at", render: (v: string) => new Date(v).toLocaleString("ru-RU") },
              {
                title: "Статус",
                dataIndex: "is_active",
                render: (v: boolean) => (v ? <Tag color="green">Активно</Tag> : <Tag>В архиве</Tag>),
              },
              {
                title: "Действия",
                render: (_, t) =>
                  canManage && (
                    <Space onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="small"
                        onClick={() => archiveTaskMutation.mutate({ id: t.id, isActive: !t.is_active })}
                        loading={archiveTaskMutation.isPending}
                      >
                        {t.is_active ? "В архив" : "Восстановить"}
                      </Button>
                      <Button size="small" danger onClick={() => deleteTaskMutation.mutate(t.id)} loading={deleteTaskMutation.isPending}>
                        {user?.is_superuser ? "🗑️ Удалить задание" : "Запросить удаление"}
                      </Button>
                    </Space>
                  ),
              },
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
          Строки задания — общий редактируемый список ниже: заполните их из состава модели и/или из наряд-заказа
          (ни один из способов не знает плёнку, только форму деталей — номенклатуру для обоих выбирайте полем ниже),
          либо добавьте вручную. Линия не выбирается здесь — задание ставится на участок, а по линиям/дням/сотрудникам
          его распределяет начальник участка отдельно (кнопка «Распределить» у уже созданного задания).
        </Typography.Paragraph>

        <Typography.Title level={5}>Материал для загружаемых строк</Typography.Title>
        <Typography.Paragraph type="secondary">
          Общий выбор для обоих способов ниже — из состава модели и из наряд-заказа.
        </Typography.Paragraph>
        <Select
          showSearch
          placeholder="Выберите позицию материала"
          options={skuOptions}
          optionFilterProp="label"
          value={selectedSkuId}
          onChange={setSelectedSkuId}
          style={{ width: "100%", marginBottom: 24 }}
        />

        <Typography.Title level={5}>Начать из модели (BOM)</Typography.Title>
        <Form form={bomForm} layout="vertical">
          <Form.Item name="product_model_id" label="Модель продукции" rules={[{ required: true }]}>
            <Select
              placeholder="Выберите модель"
              options={activeModels.map((m) => ({ value: m.id, label: `${m.name} (${areaLabel(m.area)})` }))}
              notFoundContent={<Typography.Text type="secondary">Нет моделей с заполненным BOM — заведите на вкладке «Модели продукции»</Typography.Text>}
            />
          </Form.Item>
          <Form.Item name="quantity" label="Количество, шт" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button block disabled={!bomProductModelId || !selectedSkuId} onClick={loadLinesFromBom}>
            Загрузить строки из состава
          </Button>
        </Form>

        <Typography.Title level={5} style={{ marginTop: 24 }}>
          Загрузить наряд-заказ
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          Файл содержит только форму деталей (название/ширина/длина/кол-во) — материал выбирается общим полем выше.
        </Typography.Paragraph>
        <Upload
          accept=".xls"
          showUploadList={false}
          disabled={!selectedSkuId}
          beforeUpload={(file) => {
            parseNaryadMutation.mutate(file);
            return false;
          }}
        >
          <Button block disabled={!selectedSkuId} loading={parseNaryadMutation.isPending}>
            Загрузить файл наряд-заказа (.xls)
          </Button>
        </Upload>

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
            scroll={{ x: "max-content" }}
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

      {reportTarget && (
        <ReportModal
          taskId={reportTarget.taskId}
          line={reportTarget.line}
          onClose={() => setReportTarget(null)}
        />
      )}

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
              scroll={{ x: "max-content" }}
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

/** Отчёт о производстве/браке — раздел про брак по дням: отчёт всегда
 * привязан к конкретной записи распределения (день/линия/сотрудники), не
 * к строке задания целиком, поэтому используется и из общего списка
 * заданий (мастер сам выбирает распределение из списка строки), и из
 * «Плана на день» (распределение уже известно — presetAssignmentId). */
function ReportModal({
  taskId,
  line,
  presetAssignmentId,
  onClose,
}: {
  taskId: number;
  line: ProductionTaskLine;
  presetAssignmentId?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [defectRows, setDefectRows] = useState<{ reason: string; qty: number; note?: string }[]>([]);
  const [reportForm] = Form.useForm<{ assignment_id: number; good_pieces: number }>();
  const [defectRowForm] = Form.useForm<{ reason: string; qty: number; note?: string }>();
  const writeOffReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "production"],
    queryFn: () => listWriteOffReasons("production"),
  });
  const reasonName = (code: string) => writeOffReasonsQuery.data?.find((r) => r.code === code)?.name ?? code;

  const addDefectRow = (v: { reason: string; qty: number; note?: string }) => {
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
    mutationFn: async (v: { assignment_id: number; good_pieces: number }) => {
      const calls: Promise<unknown>[] = [];
      if (v.good_pieces > 0) {
        calls.push(
          createTaskLineReport(taskId, line.id, {
            assignment_id: v.assignment_id,
            good_pieces: v.good_pieces,
            defect_pieces: 0,
          }),
        );
      }
      for (const row of defectRows) {
        calls.push(
          createTaskLineReport(taskId, line.id, {
            assignment_id: v.assignment_id,
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
      message.success("Отчёт сохранён");
      onClose();
    },
    onError: () => message.error("Не удалось сохранить отчёт"),
  });

  return (
    <Modal title={`Отчёт по линии «${line.part_name ?? line.line_name}»`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Нужно: {line.quantity_pieces} шт, уже произведено: {line.produced_good_pieces} шт, остаток: {line.remaining_pieces} шт.
      </Typography.Paragraph>
      <Form layout="vertical" form={reportForm} initialValues={{ assignment_id: presetAssignmentId, good_pieces: 0 }}>
        <Form.Item name="assignment_id" label="Распределение (день/линия)" rules={[{ required: true }]}>
          <Select
            disabled={!!presetAssignmentId}
            placeholder="Выберите день/линию распределения"
            options={line.assignments.map((a) => ({
              value: a.id,
              label: `${dayjs(a.date).format("DD.MM.YYYY")} — ${a.line_name} (${a.employee_names}), план ${a.quantity_pieces} шт`,
            }))}
            notFoundContent={
              <Typography.Text type="secondary">
                Сначала распределите строку по дням — кнопка «Распределить по дням»
              </Typography.Text>
            }
          />
        </Form.Item>
        <Form.Item name="good_pieces" label="Хороших деталей, шт" rules={[{ required: true }]}>
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
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Причина брака", dataIndex: "reason", render: (v: string) => reasonName(v) },
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
        Брак может быть по нескольким причинам сразу — например, 1 деталь мусор под плёнкой, 2 деталь царапины:
        добавьте отдельную строку на каждую причину.
      </Typography.Paragraph>
      <Form form={defectRowForm} layout="vertical" onFinish={addDefectRow}>
        <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
          <Select
            loading={writeOffReasonsQuery.isLoading}
            options={(writeOffReasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))}
          />
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
              reportMutation.mutate(v);
            })
            .catch(() => {});
        }}
      >
        Сохранить отчёт
      </Button>
    </Modal>
  );
}

function DailyPlanTab() {
  const { user } = useAuth();
  const canReport =
    !!user?.is_superuser ||
    !!user?.permissions.includes("production_tasks.manage") ||
    !!user?.permissions.includes("production_tasks.report");
  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs>(dayjs());
  const [reportTarget, setReportTarget] = useState<{ taskId: number; line: ProductionTaskLine; assignmentId: number } | null>(
    null,
  );

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const tasks = (tasksQuery.data ?? []).filter((t) => (!user?.area || t.area === user.area) && t.is_active);

  const dateStr = selectedDate.format("YYYY-MM-DD");

  const dailyItems = tasks.flatMap((task) =>
    task.lines.flatMap((line) => {
      const lineAssignments = line.assignments?.filter((a) => a.date === dateStr) ?? [];
      if (lineAssignments.length === 0) return [];
      return lineAssignments.map((a) => ({
        task,
        line,
        assignment: a,
      }));
    }),
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={`📅 Суточный план участка на ${selectedDate.format("DD.MM.YYYY")}`}
        extra={
          <Space>
            <Typography.Text>Дата смены:</Typography.Text>
            <DatePicker value={selectedDate} onChange={(d) => d && setSelectedDate(d)} format="DD.MM.YYYY" allowClear={false} />
          </Space>
        }
      >
        {dailyItems.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`На ${selectedDate.format("DD.MM.YYYY")} нет запланированных задач по линиям`}
          />
        ) : (
          <ResponsiveTable
            tableKey="daily-plan"
            lockedColumns={["Модель / Задание"]}
            defaultHiddenColumns={["Деталь", "Плёнка (номенклатура)", "Штрипс", "Сотрудники линии"]}
            rowKey={(r) => `${r.line.id}-${r.assignment.id}`}
            dataSource={dailyItems}
            pagination={false}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Модель / Задание", render: (_, r) => r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}` },
              { title: "Деталь", render: (_, r) => r.line.part_name ?? "—" },
              { title: "Линия", render: (_, r) => r.assignment.line_name },
              { title: "Плёнка (номенклатура)", render: (_, r) => `${r.line.material}, ${r.line.color}, ${r.line.thickness} мм` },
              { title: "Штрипс", render: (_, r) => `${r.line.strip_width_mm || r.line.width_mm} мм` },
              { title: "План на день", render: (_, r) => <Tag color="blue">{r.assignment.quantity_pieces} шт</Tag> },
              { title: "Сотрудники линии", render: (_, r) => r.assignment.employee_names },
              {
                title: "Хорошие/Брак за день",
                render: (_, r) => (
                  <Space size={4}>
                    <Tag color="green">{r.assignment.produced_good_pieces} шт</Tag>
                    {r.assignment.defect_pieces > 0 && <Tag color="red">брак {r.assignment.defect_pieces} шт</Tag>}
                  </Space>
                ),
              },
              {
                title: "Действия",
                render: (_, r) =>
                  canReport && (
                    <Button
                      size="small"
                      onClick={() => setReportTarget({ taskId: r.task.id, line: r.line, assignmentId: r.assignment.id })}
                    >
                      Отчитаться
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </Card>

      {reportTarget && (
        <ReportModal
          taskId={reportTarget.taskId}
          line={reportTarget.line}
          presetAssignmentId={reportTarget.assignmentId}
          onClose={() => setReportTarget(null)}
        />
      )}
    </Space>
  );
}

export default function ProductionTasks() {
  return (
    <Card>
      <Typography.Title level={4}>Производственные задания цеха</Typography.Title>
      <Tabs
        items={[
          { key: "daily-plan", label: "📅 План на день (Мастер)", children: <DailyPlanTab /> },
          { key: "tasks", label: "📋 Все задания (Неделя)", children: <TasksTab /> },
        ]}
      />
    </Card>
  );
}
