import { useState } from "react";
import { Card, Table, Button, Tag, Space, Typography, Empty, Checkbox, message, Grid, Modal, InputNumber, Form, Select } from "antd";
// Раздел про широкую таблицу строк задания — ResponsiveTable только для
// внутренней таблицы строк (плоский список, без expandable). Внешняя
// таблица заданий использует expandable (клик-разворот строки задания)
// — ResponsiveTable в узком/карточном режиме (ниже cardBreakpoint) не
// умеет expandable вообще, там осталась обычная antd Table, чтобы не
// сломать разворот на планшете в портретной ориентации.
import ResponsiveTable from "../../../components/ResponsiveTable";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listProductionTasks,
  deleteProductionTask,
  archiveProductionTask,
  updateTaskLineSpec,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineSpecUpdate,
} from "../../../api/production";
import { listMaterialSkus } from "../../../api/dictionaries";
import { skuLabel } from "../../../api/units";
import { listUsers } from "../../../api/users";
import { listAreas } from "../../../api/areas";
import { useAuth } from "../../../auth/AuthContext";
import CreateTaskModal from "./CreateTaskModal";
import AssignmentModal from "./AssignmentModal";
import ReportModal from "./ReportModal";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** Все задания (список + создание/архив/удаление) — раздел про
 * производственные задания цеха. Создание, распределение по линиям и
 * отчёт о браке живут в отдельных компонентах-модалках (CreateTaskModal,
 * AssignmentModal, ReportModal — раздел 16 бэклога доработок,
 * ProductionTasks.tsx разросся до 889 строк одним файлом), этот компонент
 * только держит список и переключает, какая модалка сейчас открыта. */
export default function TasksTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  // Раздел про карточный режим внутри expandable-строки — scroll={{x:
  // "max-content"}} на этой (внешней) таблице задаёт ей инлайновый
  // width:max-content + table-layout:fixed по сумме ширин колонок; строка
  // разворота (expandedRowRender) наследует эту же раздутую ширину
  // независимо от реального экрана, из-за чего внутренний ResponsiveTable
  // в карточном режиме на планшете отрисовывал значения карточек за
  // пределами видимой области (в DOM были, физически невидимы). Тот же
  // breakpoint, что уже в ResponsiveTable.tsx (по умолчанию "md") — scroll.x
  // нужен только на широком экране, где сама эта таблица и раздута.
  const screens = Grid.useBreakpoint();
  const wideScreen = screens.md ?? true;
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const canReport = canManage || !!user?.permissions.includes("production_tasks.report");
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ taskId: number; line: ProductionTaskLine; area: string } | null>(null);
  const [assignTarget, setAssignTarget] = useState<{ task: ProductionTask; line: ProductionTaskLine } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Раздел про правку размера/материала прямо в задании (пока размеры ещё
  // тестируются и не всегда хватает нужной номенклатуры) — то же самое,
  // что и sync_part_to_task_lines/override_strip_width/override_material
  // на резке, но явно, из самого списка заданий.
  const [dimsTarget, setDimsTarget] = useState<{ taskId: number; line: ProductionTaskLine } | null>(null);
  const [dimsForm] = Form.useForm<ProductionTaskLineSpecUpdate>();

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const usersQuery = useQuery({ queryKey: ["users-summary"], queryFn: listUsers });
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  const skuOptions = (skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }));
  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  // Раздел про отключение распределения по дням — участок с
  // requires_daily_plan=false планируется просто "на участок", мастеру не
  // предлагаем "Распределить по дням" для его заданий (см. Issue.tsx —
  // там же для таких участков убрана метка "не распределено").
  const areaRequiresDailyPlan = (code: string) => areasQuery.data?.find((a) => a.code === code)?.requires_daily_plan ?? true;

  const tasks = (tasksQuery.data ?? [])
    .filter((t) => !user?.area || t.area === user.area)
    .filter((t) => showArchived || t.is_active);

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

  const dimsMutation = useMutation({
    mutationFn: (payload: ProductionTaskLineSpecUpdate) => updateTaskLineSpec(dimsTarget!.taskId, dimsTarget!.line.id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success("Строка задания обновлена");
      setDimsTarget(null);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось изменить строку")),
  });

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
            scroll={wideScreen ? { x: "max-content" } : undefined}
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
                  // width:0 + minWidth:"100%" (раздел про карточный режим внутри
                  // expandable-строки) — у внешней таблицы задан scroll={{x:
                  // "max-content"}}, из-за чего обычные "100%" здесь считались
                  // от раздутой max-content-ширины самой таблицы, а не от
                  // видимой ширины экрана: на планшете значения карточек
                  // ResponsiveTable уезжали за пределы экрана невидимыми (сам
                  // текст был в DOM, но физически за пределами viewport).
                  <Space direction="vertical" size={8} style={{ width: 0, minWidth: "100%" }}>
                    <Space wrap size={[16, 4]}>
                      {[...bySku.values()].map((e) => (
                        <Typography.Text key={e.label}>
                          <strong>{e.label}</strong> — всего на задание {e.totalM.toFixed(2)} м
                          {e.shortfallM > 0 && <>, ещё выдать {e.shortfallM.toFixed(2)} м</>}
                        </Typography.Text>
                      ))}
                    </Space>
                    <ResponsiveTable<ProductionTaskLine>
                      tableKey="production-task-lines"
                      lockedColumns={["Деталь"]}
                      defaultHiddenColumns={["Линия", "Материал", "Размер детали", "Погонаж на строку, м"]}
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
                        { title: "Штрипс (плёнка), мм", render: (_, l) => l.strip_width_mm ?? "авто" },
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
                            (canReport || canManage) && (
                              <Space size={4} wrap>
                                {canReport && (
                                  <>
                                    {areaRequiresDailyPlan(task.area) && (
                                      <Button size="small" type="primary" ghost onClick={() => setAssignTarget({ task, line: l })}>
                                        📅 Распределить по дням
                                      </Button>
                                    )}
                                    <Button size="small" onClick={() => setReportTarget({ taskId: task.id, line: l, area: task.area })}>
                                      Отчитаться о производстве
                                    </Button>
                                  </>
                                )}
                                {canManage && (
                                  <Button
                                    size="small"
                                    onClick={() => {
                                      setDimsTarget({ taskId: task.id, line: l });
                                      const currentSku = skusQuery.data?.find(
                                        (s) =>
                                          s.material.name === l.material &&
                                          s.color.name === l.color &&
                                          Math.abs(s.thickness.value_mm - l.thickness) < 0.001,
                                      );
                                      dimsForm.setFieldsValue({
                                        width_mm: l.width_mm,
                                        length_m: l.length_m,
                                        strip_width_mm: l.strip_width_mm ?? undefined,
                                        sku_id: currentSku?.id,
                                      });
                                    }}
                                  >
                                    Изменить размер/материал
                                  </Button>
                                )}
                              </Space>
                            ),
                        },
                      ]}
                    />
                  </Space>
                );
              },
            }}
            // На узком экране без scroll.x/фиксированных ширин колонок (см.
            // wideScreen выше) заголовки всех 8 колонок вмиг не помещаются и
            // переносятся по одной букве — тот же класс бага, что уже чинили
            // на "Стеллажах". Показываем только самое нужное для беглого
            // просмотра списка (остальное всё равно видно после разворота
            // строки), не пытаясь втиснуть все колонки на узкий экран.
            columns={(
              [
                { key: "model", title: "Модель", width: wideScreen ? 320 : undefined, ellipsis: true, render: (_, t) => t.product_model_name ?? t.name ?? "—" },
                { key: "area", title: "Участок", width: wideScreen ? 140 : undefined, dataIndex: "area", render: (v: string) => areaLabel(v) },
                { key: "quantity", title: "Количество", width: wideScreen ? 110 : undefined, render: (_, t) => t.quantity ?? "—" },
                {
                  // Раздел про план/факт по расходу плёнки — план не мутируется
                  // (кол-во деталей × длина на деталь по всем строкам), факт —
                  // уже выдано/отрезано складом (issued_length_m), не зависит
                  // от бумажной самоотчётности цеха о производстве.
                  key: "planfact",
                  title: "План/факт, м",
                  width: wideScreen ? 150 : undefined,
                  render: (_, t) => (
                    <Tag color={t.planned_length_m > 0 && t.issued_length_m >= t.planned_length_m ? "green" : "orange"}>
                      {t.issued_length_m} / {t.planned_length_m}
                    </Tag>
                  ),
                },
                { key: "author", title: "Автор", width: wideScreen ? 160 : undefined, ellipsis: true, dataIndex: "created_by", render: (id: number) => userName(id) },
                { key: "created", title: "Создано", width: wideScreen ? 170 : undefined, dataIndex: "created_at", render: (v: string) => new Date(v).toLocaleString("ru-RU") },
                {
                  key: "status",
                  title: "Статус",
                  width: wideScreen ? 110 : undefined,
                  dataIndex: "is_active",
                  render: (v: boolean) => (v ? <Tag color="green">Активно</Tag> : <Tag>В архиве</Tag>),
                },
                {
                  key: "actions",
                  title: "Действия",
                  width: wideScreen ? 240 : undefined,
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
              ] as Array<{ key: string } & NonNullable<React.ComponentProps<typeof Table<ProductionTask>>["columns"]>[number]>
            ).filter((c) => wideScreen || ["model", "area", "status", "actions"].includes(c.key))}
          />
        )}
      </Card>

      <CreateTaskModal open={taskModalOpen} onClose={() => setTaskModalOpen(false)} />

      {reportTarget && (
        <ReportModal
          taskId={reportTarget.taskId}
          line={reportTarget.line}
          requiresDailyPlan={areaRequiresDailyPlan(reportTarget.area)}
          requiresRoll={reportTarget.area === "okutka_tsargovykh"}
          onClose={() => setReportTarget(null)}
        />
      )}

      {assignTarget && (
        <AssignmentModal task={assignTarget.task} line={assignTarget.line} onClose={() => setAssignTarget(null)} />
      )}

      <Modal
        title={`Размер/материал строки — ${dimsTarget?.line.part_name ?? ""}`}
        open={!!dimsTarget}
        onCancel={() => setDimsTarget(null)}
        onOk={() => dimsForm.validateFields().then((values) => dimsMutation.mutate(values))}
        confirmLoading={dimsMutation.isPending}
        okText="Сохранить"
      >
        <Typography.Paragraph type="secondary">
          Если по этой строке уже была резка, отчёт о выпуске или распределение по линии — изменить размер/материал не
          получится, об этом скажет ошибка при сохранении.
        </Typography.Paragraph>
        <Form form={dimsForm} layout="vertical">
          <Form.Item name="sku_id" label="Материал (номенклатура)">
            <Select showSearch placeholder="Оставить как есть" allowClear options={skuOptions} optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="width_mm" label="Ширина детали (заготовки), мм" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={0.001} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="strip_width_mm" label="Ширина плёнки на укутку (штрипс), мм" tooltip="Пусто — считается автоматически по названию детали">
            <InputNumber min={0.01} step={0.01} style={{ width: "100%" }} placeholder="авто" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
