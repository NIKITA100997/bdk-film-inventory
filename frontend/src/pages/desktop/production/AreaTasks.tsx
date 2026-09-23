import { useState } from "react";
import { isAxiosError } from "axios";
import dayjs, { type Dayjs } from "dayjs";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import OccurredAtField from "../../../components/OccurredAtField";
import { toOccurredAtIso } from "../../../utils/occurredAt";
import { useAuth } from "../../../auth/AuthContext";
import { listAreas } from "../../../api/areas";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import {
  createAreaTask,
  createAreaTaskReport,
  listAreaPartStages,
  listAreaTaskReports,
  listAreaTasks,
  updateAreaTask,
  type AreaTask,
  type AreaTaskLine,
} from "../../../api/areaTasks";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const fmt = (n: number) => Math.round(n * 100) / 100;

/** Задания участкам — работа без плёнки для любого участка, у каждого
 * участка свой список. «Задания цеха» остаются для плёнки. Строка может быть
 * привязана к этапу детали п/ф — тогда отчёт двигает её партии на участке. */
export default function AreaTasks() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const canReport = canManage || !!user?.permissions.includes("production_tasks.report");
  const [area, setArea] = useState<string | undefined>(user?.area ?? undefined);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ task: AreaTask; line: AreaTaskLine } | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ task: AreaTask; line: AreaTaskLine } | null>(null);
  const [creating, setCreating] = useState(false);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const areaName = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;

  const tasksQuery = useQuery({
    queryKey: ["area-tasks", area, includeClosed],
    queryFn: () => listAreaTasks({ area, include_closed: includeClosed }),
    enabled: !!area,
  });

  const closeMutation = useMutation({
    mutationFn: (t: AreaTask) => updateAreaTask(t.id, { is_active: !t.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["area-tasks"] }),
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось изменить задание")),
  });

  const tasks = tasksQuery.data ?? [];

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Задания участков"
        extra={
          canManage &&
          area && (
            <Button type="primary" onClick={() => setCreating(true)}>
              Новое задание
            </Button>
          )
        }
      >
        <Space wrap size={[12, 12]}>
          {canManage ? (
            <Select
              style={{ width: 360 }}
              placeholder="Выберите участок"
              options={areaOptions}
              value={area}
              onChange={setArea}
              showSearch
              optionFilterProp="label"
            />
          ) : (
            <Typography.Text strong>{area ? areaName(area) : "За вами не закреплён участок"}</Typography.Text>
          )}
          <Checkbox checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)}>
            Показывать закрытые
          </Checkbox>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          Работа участка без плёнки. Если строка привязана к этапу детали п/ф, отчёт сам двигает её партии: на первом
          этапе детали — рождает партию, на следующих — переводит дальше, брак списывает.
        </Typography.Paragraph>
      </Card>

      {area && !tasksQuery.isLoading && tasks.length === 0 && (
        <Card>
          <Empty description="На участке нет открытых заданий" />
        </Card>
      )}

      {tasks.map((task) => {
        const plan = task.lines.reduce((s, l) => s + l.quantity_pieces, 0);
        const done = task.lines.reduce((s, l) => s + Math.min(l.good_pieces, l.quantity_pieces), 0);
        return (
          <Card
            key={task.id}
            title={
              <Space wrap size={8}>
                <span>{task.name}</span>
                {task.source === "shield_batch" && <Tag color="purple">запуск щитовых</Tag>}
                {task.source === "pf_demand" && <Tag color="blue">пополнение п/ф</Tag>}
                {!task.is_active && <Tag>закрыто</Tag>}
                {task.ship_date && (
                  <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
                    отгрузка {dayjs(task.ship_date).format("DD.MM.YYYY")}
                  </Typography.Text>
                )}
              </Space>
            }
            extra={
              <Space>
                <Progress type="circle" size={36} percent={plan > 0 ? Math.round((100 * done) / plan) : 0} />
                {canManage && (
                  <Button size="small" loading={closeMutation.isPending} onClick={() => closeMutation.mutate(task)}>
                    {task.is_active ? "Закрыть" : "Открыть снова"}
                  </Button>
                )}
              </Space>
            }
          >
            {task.note && <Typography.Paragraph type="secondary">{task.note}</Typography.Paragraph>}
            <ResponsiveTable<AreaTaskLine>
              tableKey="area-task-lines"
              lockedColumns={["Наименование"]}
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={task.lines}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Наименование", dataIndex: "name" },
                {
                  title: "Деталь п/ф",
                  render: (_, l) =>
                    l.part_name ? (
                      <span>
                        {l.part_name} · <Typography.Text type="secondary">{l.stage_name}</Typography.Text>
                      </span>
                    ) : (
                      "—"
                    ),
                },
                { title: "План", render: (_, l) => fmt(l.quantity_pieces) },
                { title: "Сделано", render: (_, l) => fmt(l.good_pieces) },
                { title: "Брак", render: (_, l) => (l.defect_pieces ? <Tag color="red">{fmt(l.defect_pieces)}</Tag> : 0) },
                {
                  title: "Осталось",
                  render: (_, l) =>
                    l.remaining_pieces > 0 ? <b>{fmt(l.remaining_pieces)}</b> : <Tag color="green">готово</Tag>,
                },
                {
                  title: "",
                  render: (_, l) => (
                    <Space size={4}>
                      {canReport && task.is_active && (
                        <Button size="small" type="primary" onClick={() => setReportTarget({ task, line: l })}>
                          Отчёт
                        </Button>
                      )}
                      <Button size="small" onClick={() => setHistoryTarget({ task, line: l })}>
                        История
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        );
      })}

      {reportTarget && <ReportModal target={reportTarget} onClose={() => setReportTarget(null)} />}
      {historyTarget && <HistoryModal target={historyTarget} onClose={() => setHistoryTarget(null)} />}
      {creating && area && <CreateTaskModal area={area} areaName={areaName(area)} onClose={() => setCreating(false)} />}
    </Space>
  );
}

function ReportModal({ target, onClose }: { target: { task: AreaTask; line: AreaTaskLine }; onClose: () => void }) {
  const qc = useQueryClient();
  const { task, line } = target;
  const [form] = Form.useForm<{ good_pieces?: number; defect_pieces?: number; defect_reason?: string; note?: string; occurred_at?: Dayjs | null }>();
  const defect = Form.useWatch("defect_pieces", form) ?? 0;
  const reasonsQuery = useQuery({
    queryKey: ["write-off-reasons", line.part_stage_id ? "parts" : "production"],
    queryFn: () => listWriteOffReasons(line.part_stage_id ? "parts" : "production"),
  });

  const mutation = useMutation({
    mutationFn: (v: { good_pieces?: number; defect_pieces?: number; defect_reason?: string; note?: string; occurred_at?: Dayjs | null }) =>
      createAreaTaskReport(task.id, line.id, {
        good_pieces: v.good_pieces ?? 0,
        defect_pieces: v.defect_pieces ?? 0,
        defect_reason: v.defect_pieces ? v.defect_reason : null,
        note: v.note?.trim() || null,
        occurred_at: toOccurredAtIso(v.occurred_at),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["area-tasks"] });
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Отчёт сохранён");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить отчёт")),
  });

  return (
    <Modal title={`Отчёт — ${line.name}`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        План {fmt(line.quantity_pieces)} шт, сделано {fmt(line.good_pieces)}, осталось {fmt(line.remaining_pieces)}.
      </Typography.Paragraph>
      {line.part_name && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={`Партии «${line.part_name}» на этапе «${line.stage_name}» сдвинутся автоматически.`}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => {
          if (!(v.good_pieces ?? 0) && !(v.defect_pieces ?? 0)) {
            message.warning("Укажите хорошие или брак");
            return;
          }
          mutation.mutate(v);
        }}
      >
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="good_pieces" label="Хорошие, шт">
            <InputNumber min={0} style={{ width: 140 }} autoFocus />
          </Form.Item>
          <Form.Item name="defect_pieces" label="Брак, шт">
            <InputNumber min={0} style={{ width: 140 }} />
          </Form.Item>
        </Space>
        {defect > 0 && (
          <Form.Item name="defect_reason" label="Причина брака" rules={[{ required: true, message: "Укажите причину брака" }]}>
            <Select
              loading={reasonsQuery.isLoading}
              options={(reasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))}
            />
          </Form.Item>
        )}
        <OccurredAtField />
        <Form.Item name="note" label="Комментарий (необязательно)">
          <Input />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Сохранить
        </Button>
      </Form>
    </Modal>
  );
}

function HistoryModal({ target, onClose }: { target: { task: AreaTask; line: AreaTaskLine }; onClose: () => void }) {
  const { task, line } = target;
  const reportsQuery = useQuery({
    queryKey: ["area-task-reports", line.id],
    queryFn: () => listAreaTaskReports(task.id, line.id),
  });
  return (
    <Modal title={`История — ${line.name}`} open onCancel={onClose} footer={null} width={640}>
      <ResponsiveTable
        size="small"
        rowKey="id"
        loading={reportsQuery.isLoading}
        dataSource={reportsQuery.data ?? []}
        pagination={false}
        locale={{ emptyText: "Отчётов пока нет" }}
        columns={[
          { title: "Дата", dataIndex: "occurred_at", render: (v: string) => dayjs(v).format("DD.MM.YYYY HH:mm") },
          { title: "Хорошие", dataIndex: "good_pieces", render: (v: number) => fmt(v) },
          { title: "Брак", dataIndex: "defect_pieces", render: (v: number) => fmt(v) },
          { title: "Кто", dataIndex: "reported_by_name" },
          { title: "Комментарий", dataIndex: "note", render: (v: string | null) => v ?? "" },
        ]}
      />
    </Modal>
  );
}

interface LineDraft {
  name: string;
  quantity_pieces: number;
  part_stage_id?: number;
}

function CreateTaskModal({ area, areaName, onClose }: { area: string; areaName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ name: string; ship_date?: Dayjs | null; note?: string; lines: LineDraft[] }>();
  const stagesQuery = useQuery({ queryKey: ["area-part-stages", area], queryFn: () => listAreaPartStages(area) });
  const stageOptions = (stagesQuery.data ?? []).map((s) => ({
    value: s.part_stage_id,
    label: `${s.part_name} · ${s.stage_name}${s.is_first ? " (рождает партию)" : ""}`,
  }));

  const mutation = useMutation({
    mutationFn: (v: { name: string; ship_date?: Dayjs | null; note?: string; lines: LineDraft[] }) =>
      createAreaTask({
        area,
        name: v.name,
        ship_date: v.ship_date ? v.ship_date.format("YYYY-MM-DD") : null,
        note: v.note?.trim() || null,
        lines: v.lines.map((l) => ({ name: l.name, quantity_pieces: l.quantity_pieces, part_stage_id: l.part_stage_id ?? null })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["area-tasks"] });
      message.success("Задание создано");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать задание")),
  });

  return (
    <Modal title={`Новое задание — ${areaName}`} open onCancel={onClose} footer={null} destroyOnHidden width={760}>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ lines: [{ name: "", quantity_pieces: undefined }] }}
        onFinish={(v) => mutation.mutate(v)}
      >
        <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }]}>
          <Input placeholder="Например: Каркасы на запуск 16.09" />
        </Form.Item>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="ship_date" label="Дата отгрузки (необязательно)">
            <DatePicker format="DD.MM.YYYY" />
          </Form.Item>
          <Form.Item name="note" label="Комментарий" style={{ flex: 1 }}>
            <Input />
          </Form.Item>
        </Space>
        <Typography.Text strong>Строки</Typography.Text>
        <Form.List name="lines">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Space key={field.key} align="start" wrap style={{ display: "flex", marginTop: 8 }}>
                  <Form.Item name={[field.name, "part_stage_id"]} style={{ width: 280, marginBottom: 0 }}>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder="Деталь п/ф (необязательно)"
                      loading={stagesQuery.isLoading}
                      options={stageOptions}
                      onChange={(id) => {
                        const opt = stagesQuery.data?.find((s) => s.part_stage_id === id);
                        const current = form.getFieldValue(["lines", field.name, "name"]);
                        if (opt && !current) form.setFieldValue(["lines", field.name, "name"], opt.part_name);
                      }}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, "name"]}
                    rules={[{ required: true, whitespace: true, message: "Наименование" }]}
                    style={{ width: 240, marginBottom: 0 }}
                  >
                    <Input placeholder="Наименование" />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, "quantity_pieces"]}
                    rules={[{ required: true, message: "Кол-во" }]}
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber min={1} placeholder="шт" style={{ width: 100 }} />
                  </Form.Item>
                  {fields.length > 1 && <Button onClick={() => remove(field.name)}>Убрать</Button>}
                </Space>
              ))}
              <Button style={{ marginTop: 8 }} onClick={() => add({ name: "", quantity_pieces: undefined })}>
                + строка
              </Button>
            </>
          )}
        </Form.List>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending} style={{ marginTop: 16 }}>
          Создать
        </Button>
      </Form>
    </Modal>
  );
}
