import { useMemo, useState } from "react";
import { Table, Tag, Space, Button, Modal, Form, InputNumber, Input, Select, Checkbox, Typography, message, Empty } from "antd";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getReconciliation,
  linkTaskLine,
  setLegacyTaskNote,
  returnUnit,
  writeOffUnit,
  type ReconciliationRow,
} from "../../../api/units";
import { listProductionTasks, type ProductionTask, type ProductionTaskLine } from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { useAuth } from "../../../auth/AuthContext";
import OccurredAtField from "../../../components/OccurredAtField";
import { toOccurredAtIso } from "../../../utils/occurredAt";
import ReportModal from "./ReportModal";

// Раздел про сверку рулонов на окутке — пилот "Ежедневки" вскрыл разрыв
// между тремя вкладками (Выдача участку, карточка единицы, отчёт по
// заданию): десятки уже выданных/возвращённых рулонов без привязки к
// заданию или без единого отчёта о производстве. Один список вместо трёх,
// с точечными действиями, чтобы дозаполнить связи задним числом.
const AREA = "okutka_tsargovykh";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

type Bucket = "all" | "no_task" | "no_report" | "legacy";

function bucketOf(row: ReconciliationRow): Bucket {
  if (row.legacy_task_note) return "legacy";
  if (row.task_line_id == null) return "no_task";
  if (row.reports_count === 0) return "no_report";
  return "all";
}

export default function RollReconciliationTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canLink = !!user?.is_superuser || !!user?.permissions.includes("units.issue");
  const canMarkLegacy = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const canReturn = !!user?.is_superuser || !!user?.permissions.includes("units.return");
  const canWriteOff = !!user?.is_superuser || !!user?.permissions.includes("units.writeoff");

  const [bucket, setBucket] = useState<Bucket>("all");
  const [linkTarget, setLinkTarget] = useState<ReconciliationRow | null>(null);
  const [legacyTarget, setLegacyTarget] = useState<ReconciliationRow | null>(null);
  const [returnTarget, setReturnTarget] = useState<ReconciliationRow | null>(null);
  const [writeOffTarget, setWriteOffTarget] = useState<ReconciliationRow | null>(null);
  const [reportTarget, setReportTarget] = useState<{ taskId: number; line: ProductionTaskLine } | null>(null);

  const reconciliationQuery = useQuery({
    queryKey: ["units-reconciliation", AREA],
    queryFn: () => getReconciliation(AREA),
  });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const writeOffReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "warehouse"],
    queryFn: () => listWriteOffReasons("warehouse"),
  });

  const areaLabel = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const areaTasks = useMemo(
    () => (tasksQuery.data ?? []).filter((t) => t.area === AREA && t.is_active),
    [tasksQuery.data],
  );
  const findLine = (taskLineId: number): { task: ProductionTask; line: ProductionTaskLine } | null => {
    for (const t of tasksQuery.data ?? []) {
      const l = t.lines.find((x) => x.id === taskLineId);
      if (l) return { task: t, line: l };
    }
    return null;
  };
  const taskOrderRef = (t: ProductionTask) => (t.external_order_ref ? `№${t.external_order_ref}` : t.name || `#${t.id}`);

  const rows = reconciliationQuery.data ?? [];
  const counts = {
    all: rows.length,
    no_task: rows.filter((r) => bucketOf(r) === "no_task").length,
    no_report: rows.filter((r) => bucketOf(r) === "no_report").length,
    legacy: rows.filter((r) => bucketOf(r) === "legacy").length,
  };
  const shownRows = bucket === "all" ? rows : rows.filter((r) => bucketOf(r) === bucket);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["units-reconciliation", AREA] });

  const linkMutation = useMutation({
    mutationFn: (v: { production_task_line_id: number }) => linkTaskLine(linkTarget!.unit_id, v.production_task_line_id),
    onSuccess: () => {
      message.success("Рулон привязан к заданию");
      setLinkTarget(null);
      invalidate();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось привязать")),
  });

  const legacyMutation = useMutation({
    mutationFn: (note: string | null) => setLegacyTaskNote(legacyTarget!.unit_id, note),
    onSuccess: () => {
      message.success("Пометка сохранена");
      setLegacyTarget(null);
      invalidate();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить пометку")),
  });

  const returnMutation = useMutation({
    mutationFn: (v: { actual_length_m: number; write_off: boolean; write_off_reason?: string; write_off_note?: string; occurred_at?: string }) =>
      returnUnit(returnTarget!.unit_id, {
        actual_length_m: v.actual_length_m,
        occurred_at: v.occurred_at,
        write_off_reason: v.write_off ? v.write_off_reason : undefined,
        write_off_note: v.write_off ? v.write_off_note : undefined,
      }),
    onSuccess: () => {
      message.success("Рулон возвращён");
      setReturnTarget(null);
      invalidate();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось вернуть")),
  });

  const writeOffMutation = useMutation({
    mutationFn: (v: { reason: string; note?: string }) => writeOffUnit(writeOffTarget!.unit_id, v.reason, v.note),
    onSuccess: () => {
      message.success("Списано");
      setWriteOffTarget(null);
      invalidate();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось списать")),
  });

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        {(
          [
            ["all", `Все (${counts.all})`],
            ["no_task", `Без задания (${counts.no_task})`],
            ["no_report", `Без отчёта (${counts.no_report})`],
            ["legacy", `Помечено старым (${counts.legacy})`],
          ] as [Bucket, string][]
        ).map(([key, label]) => (
          <Button key={key} type={bucket === key ? "primary" : "default"} onClick={() => setBucket(key)}>
            {label}
          </Button>
        ))}
      </Space>

      <Table
        rowKey="unit_id"
        loading={reconciliationQuery.isLoading}
        dataSource={shownRows}
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: <Empty description="Нет рулонов, подходящих под фильтр" /> }}
        columns={[
          {
            title: "Рулон",
            key: "unit",
            render: (_, r) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>№{r.unit_id}</Typography.Text>
                <Tag color={r.status === "Выдан_участку" ? "blue" : r.status === "На_хранении" ? "green" : "default"}>
                  {r.status}
                </Tag>
              </Space>
            ),
          },
          {
            title: "Ширина / остаток",
            key: "size",
            render: (_, r) => `${r.width_mm} × ${r.length_m} м`,
          },
          {
            title: "Где сейчас",
            key: "where",
            render: (_, r) => r.location_code ?? areaLabel(r.area),
          },
          {
            title: "Задание",
            key: "task",
            render: (_, r) =>
              r.task_label ? (
                <span>{r.task_label}</span>
              ) : r.legacy_task_note ? (
                <Space>
                  <Typography.Text italic type="secondary">
                    {r.legacy_task_note}
                  </Typography.Text>
                  {canMarkLegacy && (
                    <Button size="small" onClick={() => legacyMutation.mutate(null)}>
                      Снять пометку
                    </Button>
                  )}
                </Space>
              ) : (
                <Space>
                  {canLink && (
                    <Button size="small" onClick={() => setLinkTarget(r)}>
                      Привязать
                    </Button>
                  )}
                  {canMarkLegacy && (
                    <Button size="small" onClick={() => setLegacyTarget(r)}>
                      Пометить старым
                    </Button>
                  )}
                </Space>
              ),
          },
          {
            title: "Отчёты",
            key: "reports",
            render: (_, r) =>
              r.task_line_id == null ? (
                "—"
              ) : r.reports_count === 0 ? (
                <Typography.Text type="danger">нет отчётов</Typography.Text>
              ) : (
                `${r.good_pieces_sum} годных / ${r.defect_pieces_sum} брака (${r.reports_count})`
              ),
          },
          {
            title: "Действия",
            key: "actions",
            render: (_, r) => (
              <Space wrap>
                {r.task_line_id != null && (
                  <Button
                    size="small"
                    onClick={() => {
                      const found = findLine(r.task_line_id!);
                      if (found) setReportTarget({ taskId: found.task.id, line: found.line });
                      else message.error("Строка задания не найдена в списке заданий");
                    }}
                  >
                    Ввести отчёт
                  </Button>
                )}
                {canReturn && r.status === "Выдан_участку" && (
                  <Button size="small" onClick={() => setReturnTarget(r)}>
                    Вернуть
                  </Button>
                )}
                {canWriteOff && r.status === "На_хранении" && (
                  <Button size="small" danger onClick={() => setWriteOffTarget(r)}>
                    Списать
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      {linkTarget && (
        <Modal
          title={`Привязать рулон №${linkTarget.unit_id} к строке задания`}
          open
          onCancel={() => setLinkTarget(null)}
          footer={null}
          destroyOnClose
        >
          <LinkTaskLineForm
            tasks={areaTasks}
            orderRef={taskOrderRef}
            loading={linkMutation.isPending}
            onSubmit={(lineId) => linkMutation.mutate({ production_task_line_id: lineId })}
          />
        </Modal>
      )}

      {legacyTarget && (
        <LegacyNoteModal
          initial={legacyTarget.legacy_task_note}
          onCancel={() => setLegacyTarget(null)}
          onSubmit={(note) => legacyMutation.mutate(note)}
          loading={legacyMutation.isPending}
        />
      )}

      {returnTarget && (
        <ReturnModal
          row={returnTarget}
          reasons={writeOffReasonsQuery.data ?? []}
          onCancel={() => setReturnTarget(null)}
          onSubmit={(v) => returnMutation.mutate(v)}
          loading={returnMutation.isPending}
        />
      )}

      {writeOffTarget && (
        <WriteOffModal
          reasons={writeOffReasonsQuery.data ?? []}
          onCancel={() => setWriteOffTarget(null)}
          onSubmit={(v) => writeOffMutation.mutate(v)}
          loading={writeOffMutation.isPending}
        />
      )}

      {reportTarget && (
        <ReportModal
          taskId={reportTarget.taskId}
          line={reportTarget.line}
          requiresDailyPlan={areasQuery.data?.find((a) => a.code === AREA)?.requires_daily_plan ?? false}
          requiresRoll={true}
          onClose={() => {
            setReportTarget(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

// --- Привязать к строке задания -------------------------------------------

function LinkTaskLineForm({
  tasks,
  orderRef,
  loading,
  onSubmit,
}: {
  tasks: ProductionTask[];
  orderRef: (t: ProductionTask) => string;
  loading: boolean;
  onSubmit: (lineId: number) => void;
}) {
  const [taskId, setTaskId] = useState<number | null>(null);
  const [lineId, setLineId] = useState<number | null>(null);
  const task = tasks.find((t) => t.id === taskId);
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <div>
        <Typography.Text>Задание</Typography.Text>
        <Select
          style={{ width: "100%" }}
          placeholder="Выберите задание"
          value={taskId ?? undefined}
          onChange={(v) => {
            setTaskId(v);
            setLineId(null);
          }}
          options={tasks.map((t) => ({ value: t.id, label: orderRef(t) }))}
          showSearch
          optionFilterProp="label"
        />
      </div>
      <div>
        <Typography.Text>Строка задания</Typography.Text>
        <Select
          style={{ width: "100%" }}
          placeholder="Выберите строку"
          value={lineId ?? undefined}
          onChange={setLineId}
          disabled={!task}
          options={(task?.lines ?? []).map((l) => ({
            value: l.id,
            label: `${l.part_name ?? ""} ${l.color}, ${l.width_mm}×${l.length_m} м`.trim(),
          }))}
          showSearch
          optionFilterProp="label"
        />
      </div>
      <Button type="primary" block disabled={!lineId} loading={loading} onClick={() => lineId && onSubmit(lineId)}>
        Привязать
      </Button>
    </Space>
  );
}

// --- Пометить как старое задание -------------------------------------------

function LegacyNoteModal({
  initial,
  onCancel,
  onSubmit,
  loading,
}: {
  initial: string | null;
  onCancel: () => void;
  onSubmit: (note: string) => void;
  loading: boolean;
}) {
  const [form] = Form.useForm<{ note: string }>();
  return (
    <Modal
      title="Пометить как старое бумажное задание"
      open
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={loading}
      destroyOnClose
    >
      <Form form={form} layout="vertical" initialValues={{ note: initial ?? "" }} onFinish={(v) => onSubmit(v.note)}>
        <Form.Item name="note" label="Заметка" rules={[{ required: true, message: "Опишите, что это за задание" }]}>
          <Input.TextArea rows={3} placeholder="Например: Заказ №8842 от 2026-08, бумажный наряд, в систему не заведён" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// --- Вернуть (+ опционально списать сразу) ----------------------------------

function ReturnModal({
  row,
  reasons,
  onCancel,
  onSubmit,
  loading,
}: {
  row: ReconciliationRow;
  reasons: { code: string; name: string }[];
  onCancel: () => void;
  onSubmit: (v: { actual_length_m: number; write_off: boolean; write_off_reason?: string; write_off_note?: string; occurred_at?: string }) => void;
  loading: boolean;
}) {
  const [form] = Form.useForm<{ actual_length_m: number; write_off: boolean; write_off_reason?: string; write_off_note?: string; occurred_at?: import("dayjs").Dayjs }>();
  const writeOff = Form.useWatch("write_off", form);
  return (
    <Modal
      title={`Вернуть рулон №${row.unit_id}`}
      open
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={loading}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ actual_length_m: row.length_m, write_off: false }}
        onFinish={(v) =>
          onSubmit({
            actual_length_m: v.actual_length_m,
            write_off: v.write_off,
            write_off_reason: v.write_off_reason,
            write_off_note: v.write_off_note,
            occurred_at: toOccurredAtIso(v.occurred_at),
          })
        }
      >
        <Form.Item name="actual_length_m" label="Фактическая длина остатка, м" rules={[{ required: true }]}>
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="write_off" valuePropName="checked">
          <Checkbox>Списать этот остаток сразу</Checkbox>
        </Form.Item>
        {writeOff && (
          <>
            <Form.Item name="write_off_reason" label="Причина списания" rules={[{ required: true, message: "Выберите причину" }]}>
              <Select options={reasons.map((r) => ({ value: r.code, label: r.name }))} />
            </Form.Item>
            <Form.Item name="write_off_note" label="Комментарий">
              <Input.TextArea rows={2} />
            </Form.Item>
          </>
        )}
        <OccurredAtField />
      </Form>
    </Modal>
  );
}

// --- Списать (единица уже На_хранении) --------------------------------------

function WriteOffModal({
  reasons,
  onCancel,
  onSubmit,
  loading,
}: {
  reasons: { code: string; name: string }[];
  onCancel: () => void;
  onSubmit: (v: { reason: string; note?: string }) => void;
  loading: boolean;
}) {
  const [form] = Form.useForm<{ reason: string; note?: string }>();
  return (
    <Modal title="Списать" open onCancel={onCancel} onOk={() => form.submit()} confirmLoading={loading} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
          <Select options={reasons.map((r) => ({ value: r.code, label: r.name }))} />
        </Form.Item>
        <Form.Item name="note" label="Комментарий">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
