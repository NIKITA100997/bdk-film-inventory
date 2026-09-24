import { useMemo, useState } from "react";
import { Table, Tag, Space, Button, Modal, Form, InputNumber, Input, Select, Checkbox, Typography, message, Empty, List } from "antd";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getReconciliation,
  linkTaskLine,
  setLegacyTaskNote,
  returnUnit,
  writeOffUnit,
  getUnitEvents,
  type ReconciliationRow,
  type UnitEvent,
} from "../../../api/units";
import { listProductionTasks, type ProductionTask, type ProductionTaskLine } from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { useAuth } from "../../../auth/AuthContext";
import OccurredAtField from "../../../components/OccurredAtField";
import { LinkTaskLineForm, LegacyNoteModal } from "../../../components/TaskLineLinkControls";
import { toOccurredAtIso } from "../../../utils/occurredAt";
import ReportModal from "./ReportModal";

// Раздел про сверку рулонов на окутке — пилот "Ежедневки" вскрыл разрыв
// между тремя вкладками (Выдача участку, карточка единицы, отчёт по
// заданию): десятки уже выданных/возвращённых рулонов без привязки к
// заданию или без единого отчёта о производстве. Один список вместо трёх,
// с точечными действиями, чтобы дозаполнить связи задним числом.
// Участок сверки — первый с настройкой «рулон обязателен в отчёте»
// (единая модель, п.5); пока такой один — окутка царговых.
const DEFAULT_ROLL_AREA = "okutka_tsargovykh";

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
  // Раздел про поиск в сверке рулонов — список легко разрастается до
  // сотен строк (выданные+возвращённые рулоны за всю историю участка),
  // найти конкретный рулон/деталь/задание пролистыванием неудобно.
  const [search, setSearch] = useState("");
  const [linkTarget, setLinkTarget] = useState<ReconciliationRow | null>(null);
  const [legacyTarget, setLegacyTarget] = useState<ReconciliationRow | null>(null);
  const [returnTarget, setReturnTarget] = useState<ReconciliationRow | null>(null);
  const [writeOffTarget, setWriteOffTarget] = useState<ReconciliationRow | null>(null);
  const [reportTarget, setReportTarget] = useState<{ taskId: number; line: ProductionTaskLine } | null>(null);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const AREA = areasQuery.data?.find((a) => a.requires_roll_on_report && a.is_active)?.code ?? DEFAULT_ROLL_AREA;
  const reconciliationQuery = useQuery({
    queryKey: ["units-reconciliation", AREA],
    queryFn: () => getReconciliation(AREA),
  });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const writeOffReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "warehouse"],
    queryFn: () => listWriteOffReasons("warehouse"),
  });

  const areaLabel = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const areaTasks = useMemo(
    () => (tasksQuery.data ?? []).filter((t) => t.area === AREA && t.is_active),
    [tasksQuery.data, AREA],
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
  const bucketRows = bucket === "all" ? rows : rows.filter((r) => bucketOf(r) === bucket);
  const searchNeedle = search.trim().toLowerCase();
  const shownRows = searchNeedle
    ? bucketRows.filter((r) => {
        const haystack = [
          String(r.unit_id),
          String(r.width_mm),
          r.task_label ?? "",
          r.legacy_task_note ?? "",
          r.location_code ?? "",
          areaLabel(r.area),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(searchNeedle);
      })
    : bucketRows;

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
        <Input.Search
          allowClear
          placeholder="Поиск — № рулона, деталь, задание, ячейка…"
          style={{ width: 280 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Space>

      <Table
        rowKey="unit_id"
        loading={reconciliationQuery.isLoading}
        dataSource={shownRows}
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: <Empty description="Нет рулонов, подходящих под фильтр" /> }}
        expandable={{
          expandedRowRender: (r) => <UnitHistoryPanel unitId={r.unit_id} reasons={writeOffReasonsQuery.data ?? []} />,
        }}
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
            title: "Расход",
            key: "spend",
            render: (_, r) =>
              r.status === "Списан" ? (
                <Tag color="red">Списано</Tag>
              ) : (
                <Tag color="default">Не списано</Tag>
              ),
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
                <Space size={4}>
                  <span>{r.task_label}</span>
                  {r.task_line_id != null && findLine(r.task_line_id)?.line.is_closed && <Tag>Закрыто</Tag>}
                </Space>
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
          area={AREA}
          onClose={() => {
            setReportTarget(null);
            invalidate();
          }}
        />
      )}
    </div>
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
        <Form.Item
          name="actual_length_m"
          label="Фактическая длина остатка, м"
          rules={[{ required: true }]}
          extra="0 — если рулон израсходован полностью. Всё, что не вернулось, система досчитает как расход по этому рулону."
        >
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

// --- История расхода (раскрыть строку) --------------------------------------

function eventLengthChange(ev: UnitEvent): string {
  if (ev.from_length != null && ev.to_length != null) {
    return `${ev.from_length} м → ${ev.to_length} м`;
  }
  const sign = ev.quantity_delta_m > 0 ? "+" : "";
  return `${sign}${ev.quantity_delta_m} м`;
}

function UnitHistoryPanel({ unitId, reasons }: { unitId: number; reasons: { code: string; name: string }[] }) {
  const eventsQuery = useQuery({ queryKey: ["unit-events", unitId], queryFn: () => getUnitEvents(unitId) });
  const reasonName = (code: string) => reasons.find((r) => r.code === code)?.name ?? code;
  return (
    <List
      size="small"
      loading={eventsQuery.isLoading}
      dataSource={eventsQuery.data ?? []}
      locale={{ emptyText: "Событий пока нет" }}
      renderItem={(ev) => (
        <List.Item>
          <Space direction="vertical" size={0}>
            <span>
              <Tag color={ev.event_type === "Списание" ? "red" : undefined}>{ev.event_type.replace(/_/g, " ")}</Tag>
              {new Date(ev.timestamp).toLocaleString("ru-RU")} — <Typography.Text strong>{eventLengthChange(ev)}</Typography.Text>
            </span>
            {(ev.from_cell || ev.to_cell) && (
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                {ev.from_cell ?? "—"} → {ev.to_cell ?? "—"}
              </Typography.Text>
            )}
            {ev.write_off_reason && (
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                Причина: {reasonName(ev.write_off_reason)}
                {ev.write_off_note ? ` — ${ev.write_off_note}` : ""}
              </Typography.Text>
            )}
          </Space>
        </List.Item>
      )}
    />
  );
}
