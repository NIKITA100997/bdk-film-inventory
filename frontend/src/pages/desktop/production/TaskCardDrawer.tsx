import { useState } from "react";
import { Alert, Button, Drawer, Dropdown, Empty, Modal, Progress, Space, Table, Tabs, Tag, Typography, message } from "antd";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveProductionTask,
  completeProductionTask,
  getProductionTask,
  getTaskCard,
  lineFilmLabel,
  type ProductionTask,
  type ProductionTaskLine,
  type TaskCardReport,
} from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { listPlanSlots } from "../../../api/planning";
import { ORDER_STATUS_LABEL } from "../../../api/productionOrders";
import { isAxiosError } from "axios";
import FastReportPanel from "./fastReport/FastReportPanel";
import { rollChoices } from "./fastReport/useFastReport";

const FABRIKA = "fabrika";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

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
 * заданиям — внутри той же карточки, «← назад» возвращает. */
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
  const [stack, setStack] = useState<number[]>([]);
  const [tab, setTab] = useState("lines");
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  // Новое открытие снаружи — стек заново (без эффекта: сверяем при рендере).
  if (taskId !== openedFor) {
    setOpenedFor(taskId);
    setStack(taskId != null ? [taskId] : []);
    setTab("lines");
  }
  const current = stack.at(-1) ?? null;
  const go = (id: number) => {
    setStack((s) => [...s, id]);
    setTab("lines");
  };
  const back = () => {
    setStack((s) => s.slice(0, -1));
    setTab("lines");
  };

  return (
    <Drawer open={taskId != null} onClose={onClose} width={960} destroyOnHidden title={null} closable={false} styles={{ body: { padding: 0 } }}>
      {current != null && (
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
      )}
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
  onClose: () => void;
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
  const fabrika = t.area === FABRIKA;
  const isPf = t.for_task_id != null || (t.lines.length > 0 && t.lines.every((l) => l.material === null && l.part_name));
  const plan = t.lines.reduce((s, l) => s + l.quantity_pieces, 0);
  const done = t.lines.reduce((s, l) => s + Math.min(l.produced_good_pieces, l.quantity_pieces), 0);
  const pfTasks = card?.pf_tasks ?? [];
  const pfAllReady = pfTasks.every(pfReady);
  const reportAllowed = canReport && t.is_active && !fabrika;

  const moreItems = [
    ...(canManage && t.is_active ? [{ key: "complete", label: "Закрыть: всё сделано" }] : []),
    ...(canManage ? [{ key: "archive", label: t.is_active ? "В архив" : "Вернуть из архива" }] : []),
    { key: "list", label: "Открыть в «Все задания»" },
    { key: "planner", label: "Открыть в планировщике →" },
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
    else if (key === "archive") archiveMutation.mutate(!t.is_active);
    else if (key === "list") {
      onClose();
      navigate(`/production-tasks?task=${t.id}`);
    } else if (key === "planner") {
      onClose();
      navigate("/planner");
    }
  };

  const tabs = [
    { key: "lines", label: "Строки", children: <LinesTab t={t} fabrika={fabrika} /> },
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
          <Space direction="vertical" size={4}>
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
              <Progress percent={plan ? Math.round((done / plan) * 100) : 0} size="small" style={{ width: 120, margin: 0 }} />
              {card?.order && (
                <a
                  onClick={() => {
                    onClose();
                    navigate(`/production-orders?order=${card.order!.id}`);
                  }}
                >
                  заказ №{card.order.id} «{card.order.name}» · {ORDER_STATUS_LABEL[card.order.status as keyof typeof ORDER_STATUS_LABEL] ?? card.order.status}
                </a>
              )}
              {card?.order?.ship_date && <span>отгрузка {dayjs(card.order.ship_date).format("DD.MM")}</span>}
            </Space>
          </Space>
          <Space>
            {reportAllowed && (
              <Button type="primary" onClick={() => setTab("report")}>
                Отчитаться
              </Button>
            )}
            <Dropdown trigger={["click"]} menu={{ items: moreItems, onClick: ({ key }) => onMore(key) }}>
              <Button loading={completeMutation.isPending || archiveMutation.isPending}>Ещё ▾</Button>
            </Dropdown>
            <Button type="text" onClick={onClose} aria-label="Закрыть">
              ✕
            </Button>
          </Space>
        </Space>
      </div>
      <Tabs activeKey={tabs.some((x) => x.key === tab) ? tab : "lines"} onChange={setTab} items={tabs} style={{ padding: "0 20px 20px" }} />
    </div>
  );
}

function LinesTab({ t, fabrika }: { t: ProductionTask; fabrika: boolean }) {
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {fabrika && t.is_active && (
        <Alert
          type="info"
          showIcon
          message="По заданиям Фабрики не отчитываются"
          description="Плёнка списывается метражом. Когда сделано — «Ещё → Закрыть: всё сделано»: строки засчитаются без списания плёнки, задание уйдёт в архив."
        />
      )}
      <Table<ProductionTaskLine>
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
                <Typography.Text strong>{l.part_name ?? "—"}</Typography.Text>
                {l.operation_name && <Typography.Text type="secondary">{l.operation_name}</Typography.Text>}
              </Space>
            ),
          },
          { title: "Плёнка", render: (_, l) => (l.material ? lineFilmLabel(l) : "—") },
          {
            title: "Рулон",
            render: (_, l) => {
              const rolls = rollChoices(l);
              if (!l.material) return "—";
              if (!rolls.length) return fabrika ? "—" : <Tag color="warning">не выдан</Tag>;
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
                {l.production_closed && <Tag>закрыта</Tag>}
              </Space>
            ),
          },
          { title: "Брак", render: (_, l) => (l.defect_pieces ? <Typography.Text type="danger">{l.defect_pieces}</Typography.Text> : "—") },
        ]}
      />
    </Space>
  );
}

function PfTab({ tasks, onGo, areaName }: { tasks: ProductionTask[]; onGo: (id: number) => void; areaName: (code: string) => string }) {
  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
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
    <Table
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
    <Table
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
