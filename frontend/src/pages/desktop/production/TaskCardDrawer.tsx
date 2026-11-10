import StripPoolAdjustModal from "../../../components/StripPoolAdjustModal";
import { useState } from "react";
import OverProductionTag, { overExcess } from "../../../components/OverProductionTag";
import { ItemChars } from "../../../components/ItemChars";
import { Alert, Button, Drawer, Dropdown, Empty, Modal, Progress, Space, Tabs, Tag, Typography, message, Tooltip, Popconfirm, InputNumber, Input, Form, Select, Table } from "antd";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveProductionTask,
  closeProductionLine,
  closeTaskLine,
  setLineIlliquid,
  deleteProductionTask,
  completeProductionTask,
  getProductionTask,
  getTaskCard,
  lineFilmLabel,
  createTaskLineReportsBatch,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineReportCreate,
  type TaskCardReport,
} from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { listPlanSlots } from "../../../api/planning";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { ORDER_STATUS_LABEL } from "../../../api/productionOrders";
import { useAuth } from "../../../auth/AuthContext";
import FastReportPanel from "./fastReport/FastReportPanel";
import ReportModal from "./ReportModal";
import AssignmentModal from "./AssignmentModal";
import PfSupplyModal from "./PfSupplyModal";
import CloseByLinesModal from "./CloseByLinesModal";
import LineSpecModal from "./LineSpecModal";
import { areaRequiresRoll } from "../../../api/areas";
import { rollChoices } from "./fastReport/useFastReport";
import { apiErrorMessage } from "../../../utils/apiError";
import { sendReportWithConfirm, ReportCancelled } from "../../../utils/reportConfirm";
import { newOpKey } from "../../../utils/opKey";
import ResponsiveTable from "../../../components/ResponsiveTable";
import JobCardModal from "./JobCardModal";
import { PrinterOutlined, ThunderboltOutlined } from "@ant-design/icons";

/** Готовность задания п/ф по деталям: деталь готова, когда все её строки
 * (этапы на этом участке) сделаны или закрыты. */
function pfParts(t: ProductionTask) {
  const byPart = new Map<string, ProductionTaskLine[]>();
  for (const l of t.lines) byPart.set(l.part_name ?? "—", [...(byPart.get(l.part_name ?? "—") ?? []), l]);
  return [...byPart.entries()].map(([part, ls]) => ({
    part,
    lines: ls,
    ready: ls.every((l) => l.production_closed || l.remaining_pieces <= 0),
  }));
}
const pfReady = (t: ProductionTask) => pfParts(t).every((p) => p.ready);

/** Карточка задания участка: строки, отчёт по заданию, связанные задания
 * (окутка ↔ её п/ф), план по дням и история. Переходы по связанным
 * заданиям — внутри той же карточки, «← назад» возвращает. Панель —
 * встроенная («Задания цеха»: список слева, карточка справа), Drawer —
 * поверх экрана (заказ, план на день, узкий экран). */
export function TaskCardPanel({
  taskId,
  onClose,
  canManage,
  canReport,
}: {
  taskId: number;
  onClose?: () => void;
  canManage: boolean;
  canReport: boolean;
}) {
  const [stack, setStack] = useState<number[]>([taskId]);
  const [tab, setTab] = useState("lines");
  const [openedFor, setOpenedFor] = useState(taskId);
  // Новое задание снаружи — стек заново (без эффекта: сверяем при рендере).
  if (taskId !== openedFor) {
    setOpenedFor(taskId);
    setStack([taskId]);
    setTab("lines");
  }
  const current = stack.at(-1) ?? taskId;
  const go = (id: number) => {
    setStack((s) => [...s, id]);
    setTab("lines");
  };
  const back = () => {
    setStack((s) => s.slice(0, -1));
    setTab("lines");
  };
  return (
    <TaskCardBody
      key={current}
      id={current}
      tab={tab}
      setTab={setTab}
      onBack={stack.length > 1 ? back : undefined}
      backLabel={stack.length > 1 ? `№${stack.at(-2)}` : undefined}
      onGo={go}
      onClose={onClose}
      canManage={canManage}
      canReport={canReport}
    />
  );
}

export default function TaskCardDrawer({
  taskId,
  onClose,
  canManage,
  canReport,
}: {
  taskId: number | null;
  onClose: () => void;
  canManage: boolean;
  canReport: boolean;
}) {
  return (
    <Drawer open={taskId != null} onClose={onClose} size={960} destroyOnHidden title={null} closable={false} styles={{ body: { padding: 0 } }}>
      {taskId != null && <TaskCardPanel taskId={taskId} onClose={onClose} canManage={canManage} canReport={canReport} />}
    </Drawer>
  );
}

function TaskCardBody({
  id,
  tab,
  setTab,
  onBack,
  backLabel,
  onGo,
  onClose,
  canManage,
  canReport,
}: {
  id: number;
  tab: string;
  setTab: (t: string) => void;
  onBack?: () => void;
  backLabel?: string;
  onGo: (id: number) => void;
  onClose?: () => void;
  canManage: boolean;
  canReport: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const taskQuery = useQuery({ queryKey: ["production-tasks", "one", id], queryFn: () => getProductionTask(id) });
  const cardQuery = useQuery({ queryKey: ["production-tasks", "card", id], queryFn: () => getTaskCard(id) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
    qc.invalidateQueries({ queryKey: ["production-orders"] });
  };
  const completeMutation = useMutation({
    mutationFn: () => completeProductionTask(id),
    onSuccess: () => {
      invalidate();
      message.success("Задание закрыто: всё сделано");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось закрыть задание")),
  });
  const [supplyOpen, setSupplyOpen] = useState(false);
  const [jobCardOpen, setJobCardOpen] = useState(false);
  const [closeByLines, setCloseByLines] = useState(false);
  const authUser = useAuth().user;
  const isSuper = !!authUser?.is_superuser;
  const userArea = authUser?.area ?? null;
  const deleteMutation = useMutation({
    mutationFn: () => deleteProductionTask(id),
    onSuccess: (r) => {
      invalidate();
      message.success(r.requested ? "Заявка на удаление отправлена администратору" : "Задание удалено");
      if (r.deleted) onClose?.();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить задание")),
  });
  const archiveMutation = useMutation({
    mutationFn: (active: boolean) => archiveProductionTask(id, active),
    onSuccess: invalidate,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось")),
  });

  const t = taskQuery.data;
  const card = cardQuery.data;
  if (taskQuery.isError) return <Empty style={{ padding: 40 }} description="Задание не найдено или нет доступа" />;
  if (!t) return null;
  const areaName = areasQuery.data?.find((a) => a.code === t.area)?.name ?? t.area;
  // Участок без отчётов по строкам (Фабрика) — закрывают задание целиком.
  const fabrika = !!areasQuery.data?.find((a) => a.code === t.area)?.close_without_reports;
  const isPf = t.for_task_id != null || (t.lines.length > 0 && t.lines.every((l) => l.material === null && l.part_id != null));
  const plan = t.lines.reduce((s, l) => s + l.quantity_pieces, 0);
  const done = t.lines.reduce((s, l) => s + Math.min(l.produced_good_pieces, l.quantity_pieces), 0);
  // строки, сделанные сверх задания больше допуска (ламинация: 3 шт, стоевые — 5)
  const overLines = t.lines.filter((l) => overExcess(l, l.produced_good_pieces) > 0).length;
  const pfTasks = card?.pf_tasks ?? [];
  const pfAllReady = pfTasks.every(pfReady);
  // Задание другого участка (связанное п/ф ↔ окутка) — только просмотр.
  const foreign = !!userArea && t.area !== userArea;
  const reportAllowed = canReport && t.is_active && !foreign;

  const moreItems = [
    ...(canManage && t.is_active && t.lines.some((l) => l.part_name && !l.operation_name)
      ? [{ key: "supply", label: "Обеспечение п/ф…" }]
      : []),
    ...(canManage && t.is_active ? [{ key: "complete", label: "Закрыть: всё сделано" }] : []),
    ...(canManage && t.is_active && t.lines.some((l) => !l.is_closed) ? [{ key: "complete-lines", label: "Закрыть по позициям…" }] : []),
    ...(canManage ? [{ key: "archive", label: t.is_active ? "В архив" : "Вернуть из архива" }] : []),
    { key: "job-card", label: "📄 Маршрутная карта (Job Card)" },
    { key: "list", label: "Открыть в «Задания цеха»" },
    { key: "planner", label: "Открыть в планировщике →" },
    ...(canManage ? [{ type: "divider" as const }, { key: "delete", label: isSuper ? "Удалить задание" : "Запросить удаление", danger: true }] : []),
  ];
  const onMore = (key: string) => {
    if (key === "complete")
      Modal.confirm({
        title: "Закрыть: всё сделано?",
        content: "Все строки будут отмечены сделанными полностью — без отчёта и без списания плёнки. Задание уйдёт в архив.",
        okText: "Закрыть",
        cancelText: "Отмена",
        onOk: () => completeMutation.mutateAsync(),
      });
    else if (key === "complete-lines") setCloseByLines(true);
    else if (key === "job-card") setJobCardOpen(true);
    else if (key === "archive") archiveMutation.mutate(!t.is_active);
    else if (key === "supply") setSupplyOpen(true);
    else if (key === "delete")
      Modal.confirm({
        title: isSuper ? "Удалить задание?" : "Запросить удаление задания?",
        content: isSuper ? "Задание будет удалено." : "Заявка уйдёт администратору.",
        okText: isSuper ? "Удалить" : "Отправить",
        okButtonProps: { danger: true },
        cancelText: "Отмена",
        onOk: () => deleteMutation.mutateAsync(),
      });
    else if (key === "list") {
      onClose?.();
      navigate(`/production-tasks?task=${t.id}`);
    } else if (key === "planner") {
      onClose?.();
      navigate("/planner");
    }
  };

  const tabs = [
    {
      key: "lines",
      label: "Строки",
      children: (
        <LinesTab
          t={t}
          fabrika={fabrika}
          canManage={canManage}
          canReport={canReport && !foreign}
          dailyPlan={areasQuery.data?.find((a) => a.code === t.area)?.requires_daily_plan ?? true}
          requiresRoll={areaRequiresRoll(areasQuery.data, t.area)}
        />
      ),
    },
    ...(reportAllowed
      ? [{ key: "report", label: "Отчёт", children: <FastReportPanel area={t.area} taskId={t.id} defaultView="table" title="Отчёт по заданию" /> }]
      : []),
    ...(pfTasks.length
      ? [
          {
            key: "pf",
            label: (
              <Space size={4}>
                П/ф<Tag color={pfAllReady ? "green" : "orange"} style={{ marginInlineEnd: 0 }}>{pfAllReady ? "готов" : "не готов"}</Tag>
              </Space>
            ),
            children: <PfTab tasks={pfTasks} onGo={onGo} areaName={(c) => areasQuery.data?.find((a) => a.code === c)?.name ?? c} />,
          },
        ]
      : []),
    ...(isPf
      ? [
          {
            key: "for",
            label: card?.for_task ? "Для окутки" : "Куда",
            children: <ForTab forTask={card?.for_task ?? null} onGo={onGo} />,
          },
        ]
      : []),
    { key: "plan", label: "План", children: <PlanTab t={t} /> },
    { key: "hist", label: "История", children: <HistoryTab reports={card?.reports ?? []} loading={cardQuery.isLoading} /> },
  ];

  return (
    <div>
      <div style={{ padding: "16px 20px 0", display: "grid", gap: 8 }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }} align="start" wrap>
          <Space orientation="vertical" size={4}>
            <Space size={12}>
              {onBack && (
                <Button type="link" style={{ padding: 0 }} onClick={onBack}>
                  ← {backLabel}
                </Button>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12, letterSpacing: ".05em", textTransform: "uppercase" }}>
                Задание участку · {areaName}
              </Typography.Text>
            </Space>
            <Typography.Title level={4} style={{ margin: 0 }}>
              №{t.id} «{t.name ?? t.product_model_name ?? "Задание"}»
            </Typography.Title>
            <Space wrap size={[8, 4]}>
              <Tag color={t.is_active ? "blue" : "default"}>{t.is_active ? "в работе" : "в архиве"}</Tag>
              <span>
                сделано {done} из {plan}
              </span>
              {overLines > 0 && <Tag color="red">сверх задания: {overLines} {overLines === 1 ? "строка" : "строк"}</Tag>}
              <Progress percent={plan ? Math.round((done / plan) * 100) : 0} size="small" style={{ width: 120, margin: 0 }} />
              {card?.order && (
                <a
                  onClick={() => {
                    onClose?.();
                    navigate(`/production-orders/${card.order!.id}`);
                  }}
                >
                  заказ №{card.order.id} «{card.order.name}» · {ORDER_STATUS_LABEL[card.order.status as keyof typeof ORDER_STATUS_LABEL] ?? card.order.status}
                </a>
              )}
              {card?.order?.ship_date && <span>отгрузка {dayjs(card.order.ship_date).format("DD.MM")}</span>}
            </Space>
          </Space>
          <Space>
            <Button icon={<PrinterOutlined />} onClick={() => setJobCardOpen(true)}>
              Наряд на станок
            </Button>
            {reportAllowed && (
              <Button type="primary" onClick={() => setTab("report")}>
                Отчитаться
              </Button>
            )}
            <Dropdown trigger={["click"]} menu={{ items: moreItems, onClick: ({ key }) => onMore(key) }}>
              <Button loading={completeMutation.isPending || archiveMutation.isPending}>Ещё ▾</Button>
            </Dropdown>
            {onClose && (
              <Button type="text" onClick={onClose} aria-label="Закрыть">
                ✕
              </Button>
            )}
          </Space>
        </Space>
      </div>
      <Tabs activeKey={tabs.some((x) => x.key === tab) ? tab : "lines"} onChange={setTab} items={tabs} style={{ padding: "0 20px 20px" }} />
      {closeByLines && <CloseByLinesModal task={t} onClose={() => setCloseByLines(false)} />}
      <JobCardModal
        taskId={t.id}
        open={jobCardOpen}
        onClose={() => setJobCardOpen(false)}
        onOpenFastReport={() => setTab("report")}
      />
      {supplyOpen && (
        <PfSupplyModal taskId={t.id} taskName={t.product_model_name ?? t.name ?? ""} canManage={canManage} onClose={() => setSupplyOpen(false)} />
      )}
    </div>
  );
}

type LineAction = "report" | "assign" | "spec" | "issue-close" | "prod-close" | "illiquid";

function QuickLineReportModal({
  open,
  task,
  line,
  onClose,
  onSuccess,
}: {
  open: boolean;
  task: ProductionTask;
  line: ProductionTaskLine;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const rq = useQuery({
    queryKey: ["write-off-reasons", "production"],
    queryFn: () => listWriteOffReasons("production"),
    staleTime: 300_000,
  });
  const reasons = (rq.data ?? []).filter((r) => r.is_active !== false);

  const left = Math.max(0, line.quantity_pieces - line.produced_good_pieces);

  const onFinish = async (values: {
    good_pieces?: number;
    defect_pieces?: number;
    defect_reason?: string;
    defect_disposition?: "spisat" | "pererabotka";
    note?: string;
  }) => {
    const good = Number(values.good_pieces || 0);
    const defect = Number(values.defect_pieces || 0);
    if (good <= 0 && defect <= 0) {
      message.warning("Укажите количество годных или брак");
      return;
    }
    if (defect > 0 && !values.defect_reason) {
      message.error("Укажите причину брака");
      return;
    }

    setSubmitting(true);
    const opKey = newOpKey();
    const payloads: ProductionTaskLineReportCreate[] = [];
    if (good > 0) {
      payloads.push({
        assignment_id: null,
        material_unit_id: null,
        good_pieces: good,
        defect_pieces: 0,
        note: values.note || undefined,
      });
    }
    if (defect > 0) {
      payloads.push({
        assignment_id: null,
        material_unit_id: null,
        good_pieces: 0,
        defect_pieces: defect,
        defect_reason: values.defect_reason,
        defect_disposition: values.defect_disposition || "spisat",
        note: values.note || undefined,
      });
    }

    try {
      await sendReportWithConfirm((confirmed) =>
        createTaskLineReportsBatch(
          task.id,
          line.id,
          payloads.map((p) => ({ ...p, confirmed })),
          opKey,
        ),
      );
      message.success(`Отчёт сохранён: +${good} шт`);
      onSuccess();
      onClose();
    } catch (e) {
      if (e instanceof ReportCancelled) return;
      message.error(apiErrorMessage(e, "Не удалось сохранить отчёт"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <Space direction="vertical" size={2}>
          <span>Сдача продукции: {line.part_name || "Деталь"}</span>
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: "normal" }}>
            План: {line.quantity_pieces} шт · Сдано: {line.produced_good_pieces} шт · Остаток: {left} шт
          </Typography.Text>
        </Space>
      }
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          good_pieces: left > 0 ? left : 0,
          defect_pieces: 0,
          defect_disposition: "spisat",
        }}
        onFinish={onFinish}
        style={{ marginTop: 16 }}
      >
        <Form.Item
          name="good_pieces"
          label={
            <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
              <span>Хороших деталей, шт</span>
              {left > 0 && (
                <Button
                  size="small"
                  type="link"
                  style={{ padding: 0, height: "auto" }}
                  onClick={() => form.setFieldValue("good_pieces", left)}
                >
                  Весь остаток ({left} шт)
                </Button>
              )}
            </div>
          }
          rules={[{ required: true, message: "Введите количество" }]}
        >
          <InputNumber min={0} style={{ width: "100%" }} autoFocus />
        </Form.Item>

        <Form.Item name="defect_pieces" label="Брак, шт">
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          noStyle
          shouldUpdate={(prev, cur) => prev.defect_pieces !== cur.defect_pieces}
        >
          {({ getFieldValue }) =>
            (getFieldValue("defect_pieces") ?? 0) > 0 ? (
              <>
                <Form.Item
                  name="defect_reason"
                  label="Причина брака"
                  rules={[{ required: true, message: "Выберите причину брака" }]}
                >
                  <Select
                    placeholder="Выберите причину"
                    options={reasons.map((r) => ({ value: r.name, label: r.name }))}
                  />
                </Form.Item>
                <Form.Item name="defect_disposition" label="Что сделать с браком">
                  <Select
                    options={[
                      { value: "spisat", label: "Списать безвозвратно" },
                      { value: "pererabotka", label: "В переработку (остаётся в цехе)" },
                    ]}
                  />
                </Form.Item>
              </>
            ) : null
          }
        </Form.Item>

        <Form.Item name="note" label="Примечание (необязательно)">
          <Input placeholder="Комментарий к сдаче..." />
        </Form.Item>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <Button onClick={onClose}>Отмена</Button>
          <Button type="primary" htmlType="submit" loading={submitting}>
            Сдать
          </Button>
        </div>
      </Form>
    </Modal>
  );
}

function TaskShiftReportModal({
  open,
  task,
  onClose,
  onSuccess,
}: {
  open: boolean;
  task: ProductionTask;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const rq = useQuery({
    queryKey: ["write-off-reasons", "production"],
    queryFn: () => listWriteOffReasons("production"),
    staleTime: 300_000,
  });
  const reasons = (rq.data ?? []).filter((r) => r.is_active !== false);

  const [entries, setEntries] = useState<Record<number, { good?: number; defect?: number; reason?: string; note?: string }>>({});

  const activeLines = task.lines.filter((l) => !l.production_closed);

  const fillAllRemainders = () => {
    const next: Record<number, { good?: number; defect?: number; reason?: string; note?: string }> = {};
    for (const l of activeLines) {
      const left = Math.max(0, l.quantity_pieces - l.produced_good_pieces);
      next[l.id] = {
        good: left,
        defect: entries[l.id]?.defect || 0,
        reason: entries[l.id]?.reason,
        note: entries[l.id]?.note,
      };
    }
    setEntries(next);
  };

  const clearAll = () => setEntries({});

  const updateEntry = (lineId: number, field: string, value: unknown) => {
    setEntries((prev) => ({
      ...prev,
      [lineId]: {
        good: prev[lineId]?.good ?? 0,
        defect: prev[lineId]?.defect ?? 0,
        ...prev[lineId],
        [field]: value,
      },
    }));
  };

  const totalGood = Object.values(entries).reduce((s, e) => s + (Number(e.good) || 0), 0);
  const totalDefect = Object.values(entries).reduce((s, e) => s + (Number(e.defect) || 0), 0);

  const handleSubmit = async () => {
    const toSubmit = activeLines.filter((l) => {
      const e = entries[l.id];
      return e && ((Number(e.good) || 0) > 0 || (Number(e.defect) || 0) > 0);
    });

    if (toSubmit.length === 0) {
      message.warning("Введите сданные количества хотя бы по одной строке");
      return;
    }

    for (const l of toSubmit) {
      const e = entries[l.id];
      if ((Number(e.defect) || 0) > 0 && !e.reason) {
        message.error(`Укажите причину брака для строки: ${l.part_name || "Деталь"}`);
        return;
      }
    }

    setSubmitting(true);
    let successCount = 0;
    try {
      for (const l of toSubmit) {
        const e = entries[l.id];
        const g = Number(e.good) || 0;
        const d = Number(e.defect) || 0;
        const opKey = newOpKey();
        const payloads: ProductionTaskLineReportCreate[] = [];
        if (g > 0) {
          payloads.push({
            assignment_id: null,
            material_unit_id: null,
            good_pieces: g,
            defect_pieces: 0,
            note: e.note || undefined,
          });
        }
        if (d > 0) {
          payloads.push({
            assignment_id: null,
            material_unit_id: null,
            good_pieces: 0,
            defect_pieces: d,
            defect_reason: e.reason,
            defect_disposition: "spisat",
            note: e.note || undefined,
          });
        }
        await sendReportWithConfirm((confirmed) =>
          createTaskLineReportsBatch(
            task.id,
            l.id,
            payloads.map((p) => ({ ...p, confirmed })),
            opKey,
          ),
        );
        successCount++;
      }
      message.success(`Успешно сдано строк: ${successCount} (всего ${totalGood} шт)`);
      onSuccess();
      onClose();
    } catch (e) {
      if (e instanceof ReportCancelled) return;
      message.error(apiErrorMessage(e, "Ошибка при сохранении отчётов"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <Space direction="vertical" size={2}>
          <span>⚡ Быстрый отчёт за смену (все строки задания)</span>
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: "normal" }}>
            Задание №{task.id} «{task.name}» · Ввод готовой продукции и брака без рулонов
          </Typography.Text>
        </Space>
      }
      width={900}
      onCancel={onClose}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <Typography.Text strong>
              Всего к сдаче: <Tag color="green">{totalGood} годных</Tag>
              {totalDefect > 0 && <Tag color="red">{totalDefect} брак</Tag>}
            </Typography.Text>
          </div>
          <Space>
            <Button onClick={onClose} disabled={submitting}>
              Отмена
            </Button>
            <Button
              type="primary"
              onClick={handleSubmit}
              loading={submitting}
              disabled={totalGood === 0 && totalDefect === 0}
            >
              Сдать выбранное ({totalGood + totalDefect} шт)
            </Button>
          </Space>
        </div>
      }
      destroyOnClose
    >
      <div style={{ margin: "12px 0", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Space>
          <Button size="small" type="primary" ghost onClick={fillAllRemainders}>
            Заполнить все остатки
          </Button>
          <Button size="small" onClick={clearAll}>
            Очистить
          </Button>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Плёнка спишется автоматически по нормативу из пула участка (FIFO)
        </Typography.Text>
      </div>

      <Table<ProductionTaskLine>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={activeLines}
        scroll={{ y: 400, x: "max-content" }}
        columns={[
          {
            title: "Деталь",
            width: 220,
            render: (_, l) => (
              <Space direction="vertical" size={0}>
                <ItemChars chars={l.item_chars} name={l.part_name} />
                {l.operation_name && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{l.operation_name}</Typography.Text>}
              </Space>
            ),
          },
          {
            title: "План / Остаток",
            width: 140,
            render: (_, l) => {
              const left = Math.max(0, l.quantity_pieces - l.produced_good_pieces);
              return (
                <Space direction="vertical" size={0}>
                  <span>{l.produced_good_pieces} из {l.quantity_pieces} шт</span>
                  <Tag color={left > 0 ? "orange" : "green"} style={{ margin: 0, fontSize: 11 }}>
                    {left > 0 ? `Остаток: ${left} шт` : "Сдано"}
                  </Tag>
                </Space>
              );
            },
          },
          {
            title: "Сдано годных, шт",
            width: 160,
            render: (_, l) => {
              const left = Math.max(0, l.quantity_pieces - l.produced_good_pieces);
              const val = entries[l.id]?.good;
              return (
                <Space size={4}>
                  <InputNumber
                    min={0}
                    value={val}
                    style={{ width: 85 }}
                    onChange={(v) => updateEntry(l.id, "good", v ?? 0)}
                  />
                  {left > 0 && (
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: "0 2px", fontSize: 11 }}
                      onClick={() => updateEntry(l.id, "good", left)}
                    >
                      {left}
                    </Button>
                  )}
                </Space>
              );
            },
          },
          {
            title: "Брак, шт",
            width: 100,
            render: (_, l) => (
              <InputNumber
                min={0}
                value={entries[l.id]?.defect}
                style={{ width: 75 }}
                onChange={(v) => updateEntry(l.id, "defect", v ?? 0)}
              />
            ),
          },
          {
            title: "Причина брака",
            width: 180,
            render: (_, l) => {
              const d = Number(entries[l.id]?.defect) || 0;
              if (d <= 0) return <Typography.Text type="secondary">—</Typography.Text>;
              return (
                <Select
                  size="small"
                  placeholder="Причина"
                  value={entries[l.id]?.reason}
                  style={{ width: "100%" }}
                  onChange={(v) => updateEntry(l.id, "reason", v)}
                  options={reasons.map((r) => ({ value: r.name, label: r.name }))}
                />
              );
            },
          },
        ]}
      />
    </Modal>
  );
}

function LinesTab({
  t,
  fabrika,
  canManage,
  canReport,
  dailyPlan,
  requiresRoll,
}: {
  t: ProductionTask;
  fabrika: boolean;
  canManage: boolean;
  canReport: boolean;
  dailyPlan: boolean;
  requiresRoll: boolean;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<{ action: LineAction; line: ProductionTaskLine } | null>(null);
  const [adjustLine, setAdjustLine] = useState<ProductionTaskLine | null>(null);
  const [quickLine, setQuickLine] = useState<ProductionTaskLine | null>(null);
  const [shiftReportOpen, setShiftReportOpen] = useState(false);
  const [submittingLineId, setSubmittingLineId] = useState<number | null>(null);

  const done = () => {
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
    qc.invalidateQueries({ queryKey: ["production-task", t.id] });
    qc.invalidateQueries({ queryKey: ["production-task-card", t.id] });
    qc.invalidateQueries({ queryKey: ["production-monitor"] });
    message.success("Сохранено");
  };
  const fail = (e: unknown) => message.error(apiErrorMessage(e, "Не удалось изменить строку"));
  const issueClose = useMutation({ mutationFn: (l: ProductionTaskLine) => closeTaskLine(t.id, l.id, !l.is_closed), onSuccess: done, onError: fail });
  const prodClose = useMutation({
    mutationFn: (l: ProductionTaskLine) => closeProductionLine(t.id, l.id, !l.production_closed),
    onSuccess: done,
    onError: fail,
  });
  // «из неликвида» (23.10): подбор и резерв строки — только рулоны с пометкой неликвид
  const illiquid = useMutation({
    mutationFn: (l: ProductionTaskLine) => setLineIlliquid(t.id, l.id, !l.use_illiquid),
    onSuccess: done,
    onError: fail,
  });
  const actionsOf = (l: ProductionTaskLine) => [
    ...(canReport && t.is_active && !l.production_closed ? [{ key: "report", label: "Отчитаться (подробно)…" }] : []),
    ...(canReport && t.is_active && !l.production_closed && dailyPlan ? [{ key: "assign", label: "Распределить по дням…" }] : []),
    ...(canManage && l.material !== null ? [{ key: "spec", label: "Изменить размер/материал…" }] : []),
    ...(canManage && l.material !== null && t.is_active
      ? [{ key: "illiquid", label: l.use_illiquid ? "Брать обычные рулоны (не неликвид)" : "Делать из неликвида" }]
      : []),
    ...(canManage && l.material !== null ? [{ key: "issue-close", label: l.is_closed ? "Открыть выдачу заново" : "Закрыть по выдаче (больше не выдавать)" }] : []),
    ...(canManage ? [{ key: "prod-close", label: l.production_closed ? "Возобновить производство" : "Завершить производство по строке" }] : []),
  ];
  const onAction = (key: LineAction, l: ProductionTaskLine) => {
    if (key === "illiquid") illiquid.mutate(l);
    else if (key === "issue-close") issueClose.mutate(l);
    else if (key === "prod-close") prodClose.mutate(l);
    else setTarget({ action: key, line: l });
  };

  const handleQuickReportAll = async (l: ProductionTaskLine) => {
    const left = Math.max(0, l.quantity_pieces - l.produced_good_pieces);
    if (left <= 0) return;
    setSubmittingLineId(l.id);
    const opKey = newOpKey();
    try {
      await sendReportWithConfirm((confirmed) =>
        createTaskLineReportsBatch(
          t.id,
          l.id,
          [
            {
              assignment_id: null,
              material_unit_id: null,
              good_pieces: left,
              defect_pieces: 0,
              confirmed,
            },
          ],
          opKey,
        ),
      );
      message.success(`Сдано: ${left} шт (${l.part_name || "деталь"})`);
      done();
    } catch (e) {
      if (e instanceof ReportCancelled) return;
      message.error(apiErrorMessage(e, "Не удалось сохранить отчёт"));
    } finally {
      setSubmittingLineId(null);
    }
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {fabrika && t.is_active && canManage && (
        <Alert
          type="info"
          showIcon
          message="Участок «Фабрика»"
          description="Сдача фиксируется в штуках (кнопки «Всё (N)» / «Сдать…» или «⚡ Быстрый отчёт за смену»). Также доступно «Ещё → Закрыть: всё сделано» для закрытия задания целиком без отчётов."
        />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        {canReport && t.is_active && (
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => setShiftReportOpen(true)}
          >
            ⚡ Быстрый отчёт за смену (все строки)
          </Button>
        )}
        {(fabrika || !requiresRoll) && (
          <Tag color="blue" style={{ padding: "4px 8px" }}>
            ⚡ Упрощённый режим: сдача в штуках, списание плёнки по нормативу (FIFO)
          </Tag>
        )}
      </div>
      <ResponsiveTable<ProductionTaskLine>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={t.lines}
        scroll={{ x: "max-content" }}
        columns={[
          {
            title: "Деталь",
            render: (_, l) => (
              <Space direction="vertical" size={0}>
                <ItemChars chars={l.item_chars} name={l.part_name} />
                {l.operation_name && <Typography.Text type="secondary">{l.operation_name}</Typography.Text>}
                {l.program && <Tag color="geekblue">программа {l.program}</Tag>}
                {l.instruction && <Typography.Text type="warning">⚑ {l.instruction}</Typography.Text>}
                {(l.manual_changes ?? []).length > 0 && (
                  <Tooltip title={(l.manual_changes ?? []).join(" · ")}>
                    <Tag color="orange">изменено вручную</Tag>
                  </Tooltip>
                )}
              </Space>
            ),
          },
          {
            title: "Плёнка",
            render: (_, l) =>
              l.material ? (
                <Space size={4} wrap>
                  {lineFilmLabel(l)}
                  {l.use_illiquid && (
                    <Tooltip title="Под строку берутся только рулоны с пометкой «неликвид»">
                      <Tag color="orange">из неликвида</Tag>
                    </Tooltip>
                  )}
                </Space>
              ) : (
                "—"
              ),
          },
          {
            title: "Рулон / Штрипс",
            render: (_, l) => {
              if (!l.material) return "—";
              if (fabrika || !requiresRoll) {
                return (
                  <Space size={4} wrap>
                    {l.area_strip_stock_m != null && l.area_strip_stock_m > 0 ? (
                      <Tag color="green" title="Доступно в пуле штрипсов участка (списание FIFO)">
                        В пуле {l.area_strip_stock_m} м ({l.area_strip_count ?? 1} шт.) · FIFO
                      </Tag>
                    ) : (
                      <Tag color="warning" title="Штрипсов нужной ширины на участке нет">Пул пуст (0 м)</Tag>
                    )}
                    {l.film_deficit_m != null && l.film_deficit_m > 0 && (
                      <Tag color="error" title="Овердрафт: списано сверх фактического остатка штрипсов в цехе">
                        Дефицит: -{l.film_deficit_m} м
                      </Tag>
                    )}
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: "0 2px", fontSize: 11 }}
                      onClick={() => setAdjustLine(l)}
                      title="Экспресс-сверка фактического остатка штрипсов в пуле участка"
                    >
                      сверка
                    </Button>
                  </Space>
                );
              }
              const rolls = rollChoices(l);
              if (!rolls.length) return <Tag color="warning">не выдан</Tag>;
              return rolls.map((u) => (
                <Tag key={u.id} color={u.from ? "cyan" : "blue"} title={u.from ? `Общий рулон участка, выдан под «${u.from}»` : undefined}>
                  №{u.id} · {Math.round(u.left * 10) / 10} м{u.from ? " · общий" : ""}
                </Tag>
              ));
            },
          },
          {
            title: "Сделано",
            render: (_, l) => (
              <Space size={8}>
                <Progress percent={l.quantity_pieces ? Math.round((Math.min(l.produced_good_pieces, l.quantity_pieces) / l.quantity_pieces) * 100) : 0} size="small" style={{ width: 90, margin: 0 }} />
                <span>
                  {l.produced_good_pieces} из {l.quantity_pieces}
                </span>
                <OverProductionTag line={l} produced={l.produced_good_pieces} />
                {l.production_closed && <Tag>закрыта</Tag>}
              </Space>
            ),
          },
          { title: "Брак", render: (_, l) => (l.defect_pieces ? <Typography.Text type="danger">{l.defect_pieces}</Typography.Text> : "—") },
          {
            title: "Сдача",
            render: (_, l) => {
              if (!canReport || !t.is_active || l.production_closed) {
                return l.production_closed ? <Tag>закрыта</Tag> : "—";
              }
              const left = Math.max(0, l.quantity_pieces - l.produced_good_pieces);
              return (
                <Space size={4}>
                  {left > 0 ? (
                    <>
                      <Popconfirm
                        title={`Сдать весь остаток ${left} шт.?`}
                        description="Сдача всех оставшихся деталей строки"
                        okText="Сдать всё"
                        cancelText="Отмена"
                        onConfirm={() => handleQuickReportAll(l)}
                      >
                        <Button
                          size="small"
                          type="primary"
                          ghost
                          loading={submittingLineId === l.id}
                          title="Быстрая сдача всего остатка деталей"
                        >
                          Всё ({left})
                        </Button>
                      </Popconfirm>
                      <Button
                        size="small"
                        onClick={() => setQuickLine(l)}
                        title="Сдать часть партии или зафиксировать брак"
                      >
                        Сдать…
                      </Button>
                    </>
                  ) : (
                    <Space size={2}>
                      <Tag color="success">✓ Сдано</Tag>
                      <Button
                        size="small"
                        type="text"
                        style={{ fontSize: 11, padding: "0 4px" }}
                        onClick={() => setQuickLine(l)}
                        title="Сдать сверх плана"
                      >
                        +
                      </Button>
                    </Space>
                  )}
                </Space>
              );
            },
          },
          {
            title: "",
            render: (_, l) => {
              const items = actionsOf(l);
              return items.length ? (
                <Dropdown trigger={["click"]} menu={{ items, onClick: ({ key }) => onAction(key as LineAction, l) }}>
                  <Button size="small" loading={issueClose.isPending || prodClose.isPending} aria-label="Действия со строкой">
                    ⋯
                  </Button>
                </Dropdown>
              ) : null;
            },
          },
        ]}
      />
      {target?.action === "report" && (
        <ReportModal
          taskId={t.id}
          line={target.line}
          requiresDailyPlan={dailyPlan}
          requiresRoll={requiresRoll && target.line.material !== null}
          area={t.area}
          onClose={() => setTarget(null)}
        />
      )}
      {target?.action === "assign" && <AssignmentModal task={t} line={target.line} onClose={() => setTarget(null)} />}
      {target?.action === "spec" && <LineSpecModal taskId={t.id} line={target.line} onClose={() => setTarget(null)} />}
      {quickLine && (
        <QuickLineReportModal
          open={!!quickLine}
          task={t}
          line={quickLine}
          onClose={() => setQuickLine(null)}
          onSuccess={done}
        />
      )}
      {shiftReportOpen && (
        <TaskShiftReportModal
          open={shiftReportOpen}
          task={t}
          onClose={() => setShiftReportOpen(false)}
          onSuccess={done}
        />
      )}
      {adjustLine && (
        <StripPoolAdjustModal
          open={!!adjustLine}
          onClose={() => setAdjustLine(null)}
          area={t.area}
          material={adjustLine.material}
          materialId={adjustLine.material_id}
          color={adjustLine.color}
          colorId={adjustLine.color_id}
          thicknessId={adjustLine.thickness_id}
          stripWidthMm={adjustLine.strip_width_mm || adjustLine.width_mm}
          currentStockM={adjustLine.area_strip_stock_m}
          deficitM={adjustLine.film_deficit_m}
        />
      )}
    </Space>
  );
}

function PfTab({ tasks, onGo, areaName }: { tasks: ProductionTask[]; onGo: (id: number) => void; areaName: (code: string) => string }) {
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      {!tasks.every(pfReady) && (
        <Alert type="warning" showIcon message="П/ф ещё не готов: отчёт окутки по этим деталям не пройдёт проверку остатка, пока деталей нет на участке." />
      )}
      {tasks.map((p) => (
        <div key={p.id} style={{ border: "1px dashed #D0CCC4", borderRadius: 10, padding: "10px 14px", display: "grid", gap: 8 }}>
          <Space style={{ justifyContent: "space-between", width: "100%" }} wrap>
            <a onClick={() => onGo(p.id)}>
              №{p.id} «{p.name}» · {areaName(p.area)} →
            </a>
            <Tag color={pfReady(p) ? "green" : "orange"}>{pfReady(p) ? "готов" : "в работе"}</Tag>
          </Space>
          {pfParts(p).map(({ part, lines, ready }) => (
            <Space key={part} style={{ justifyContent: "space-between", width: "100%" }} wrap>
              <span>{part}</span>
              <Space size={4} wrap>
                {lines.map((l) => (
                  <Tag key={l.id} color={l.production_closed || l.remaining_pieces <= 0 ? "green" : ready ? "green" : "gold"}>
                    {l.operation_name ?? "этап"} {l.produced_good_pieces}/{l.quantity_pieces}
                  </Tag>
                ))}
              </Space>
            </Space>
          ))}
        </div>
      ))}
    </Space>
  );
}

function ForTab({ forTask, onGo }: { forTask: ProductionTask | null; onGo: (id: number) => void }) {
  if (!forTask)
    return <Alert type="info" showIcon message="На склад" description="Пополнение остатка п/ф без привязки к заданию окутки — готовые детали попадут в «Остатки п/ф»." />;
  return (
    <div style={{ border: "1px dashed #D0CCC4", borderRadius: 10, padding: "10px 14px", display: "grid", gap: 8 }}>
      <a onClick={() => onGo(forTask.id)}>
        №{forTask.id} «{forTask.name ?? forTask.product_model_name}» →
      </a>
      <Typography.Text type="secondary">
        Окутке нужно: {forTask.lines.map((l) => `${l.part_name ?? "—"} — ${l.quantity_pieces}`).join(", ")}
      </Typography.Text>
    </div>
  );
}

function PlanTab({ t }: { t: ProductionTask }) {
  const from = dayjs().subtract(14, "day").format("YYYY-MM-DD");
  const to = dayjs().add(45, "day").format("YYYY-MM-DD");
  const q = useQuery({ queryKey: ["plan-slots", t.area, from, to, "task"], queryFn: () => listPlanSlots({ area: t.area, date_from: from, date_to: to }) });
  const ids = new Set(t.lines.map((l) => l.id));
  const rows = (q.data ?? []).filter((s) => ids.has(s.task_line_id)).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  if (!q.isLoading && !rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="В планировщике по этому заданию ничего не стоит" />;
  const today = dayjs().format("YYYY-MM-DD");
  return (
    <ResponsiveTable
      exportTitle="План задания по дням"
      size="small"
      loading={q.isLoading}
      rowKey={(s) => `${s.id}-${s.task_line_id}-${s.date}`}
      pagination={false}
      dataSource={rows}
      columns={[
        {
          title: "День",
          render: (_, s) => (
            <Space size={4}>
              {s.date ? dayjs(s.date).format("DD.MM") : "—"}
              {s.date === today && <Tag color="blue">сегодня</Tag>}
              {s.overdue && <Tag color="red">просрочено</Tag>}
            </Space>
          ),
        },
        { title: "Что", render: (_, s) => `${s.what}${s.operation ? ` · ${s.operation}` : ""}` },
        { title: "План, шт", dataIndex: "quantity" },
        { title: "По строке сделано", render: (_, s) => `${s.line_done} из ${s.line_plan}` },
      ]}
    />
  );
}

function HistoryTab({ reports, loading }: { reports: TaskCardReport[]; loading: boolean }) {
  if (!loading && !reports.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Отчётов по заданию ещё не было" />;
  return (
    <ResponsiveTable
      exportTitle="Отчёты по заданию"
      size="small"
      loading={loading}
      rowKey="id"
      pagination={{ pageSize: 50, hideOnSinglePage: true }}
      dataSource={reports}
      columns={[
        { title: "Когда", render: (_, r) => dayjs(r.reported_at).format("DD.MM HH:mm") },
        { title: "Кто", render: (_, r) => r.user_name ?? "—" },
        { title: "Деталь", render: (_, r) => `${r.part_name ?? "—"}${r.operation_name ? ` · ${r.operation_name}` : ""}` },
        {
          title: "Отчёт",
          render: (_, r) => (
            <Space size={4} wrap>
              {r.good_pieces > 0 && <Tag color="green">{r.good_pieces} годных</Tag>}
              {r.defect_pieces > 0 && (
                <Tag color="red">
                  брак {r.defect_pieces}
                  {r.defect_reason_name ? ` · ${r.defect_reason_name}` : ""}
                </Tag>
              )}
              {r.material_unit_id && <Tag color="blue">рулон №{r.material_unit_id}</Tag>}
              {r.note && <Typography.Text type="secondary">{r.note}</Typography.Text>}
            </Space>
          ),
        },
      ]}
    />
  );
}
