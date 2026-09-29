import { useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { isAxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  InputNumber,
  Popover,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
  message,
  theme,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../../auth/AuthContext";
import {
  getPlanBoard,
  listPlanSlots,
  movePlanSlot,
  planLine,
  splitPlanSlot,
  type PlanArea,
  type PlanSlot,
} from "../../../api/planning";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const SITES: { value: string; label: string; id?: number }[] = [
  { value: "all", label: "Все площадки" },
  { value: "1", label: "Северный", id: 1 },
  { value: "2", label: "Фабрика", id: 2 },
];

type Target = { area: PlanArea; date: string | null; first: boolean; unplanned: boolean };

/** Планировщик: участки × рабочие дни (пн–пт), в клетке — сколько штук
 * запланировано. Сроки ставит запуск заказа (назад от отгрузки), здесь их
 * переносят и делят по дням; прошедшее несделанное — красным в первом дне.
 * Мощность участков пока не задаётся — видно загрузку в штуках. */
export default function Planner() {
  const { token } = theme.useToken();
  const [start, setStart] = useState<Dayjs>(dayjs().startOf("day"));
  const [site, setSite] = useState("all");
  const [target, setTarget] = useState<Target | null>(null);
  const siteId = SITES.find((s) => s.value === site)?.id;
  const from = start.format("YYYY-MM-DD");
  const to = start.add(20, "day").format("YYYY-MM-DD");
  const boardQuery = useQuery({
    queryKey: ["plan-board", from, to, siteId],
    queryFn: () => getPlanBoard({ date_from: from, date_to: to, site_id: siteId }),
  });
  const board = boardQuery.data;
  const cell = useMemo(() => {
    const m = new Map<string, { quantity: number; lines: number; overdue: number }>();
    for (const c of board?.cells ?? []) m.set(`${c.area}|${c.date}`, c);
    return m;
  }, [board]);
  const backlog = new Map((board?.backlog ?? []).map((b) => [b.area, b]));
  const today = dayjs().format("YYYY-MM-DD");
  const dayTotal = (d: string) => (board?.areas ?? []).reduce((s, a) => s + (cell.get(`${a.code}|${d}`)?.quantity ?? 0), 0);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="Планировщик производства"
        extra={
          <Space wrap>
            <Button onClick={() => setStart((s) => s.subtract(7, "day"))}>← неделя</Button>
            <Button onClick={() => setStart(dayjs().startOf("day"))}>Сегодня</Button>
            <Button onClick={() => setStart((s) => s.add(7, "day"))}>неделя →</Button>
          </Space>
        }
      >
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            Сроки ставятся при запуске заказа — назад от отгрузки по рабочим дням. Нажмите на клетку, чтобы перенести
            операцию на другой день или разделить её. Красное — запланировано на прошедшие дни и не сделано. «Без плана» —
            открытые строки заданий, у которых нет срока.
          </Typography.Text>
          <Segmented value={site} onChange={(v) => setSite(v as string)} options={SITES.map(({ value, label }) => ({ value, label }))} />
        </Space>
      </Card>

      <Card size="small" loading={boardQuery.isLoading} styles={{ body: { padding: 0 } }}>
        {board && board.areas.length === 0 ? (
          <Empty style={{ margin: 32 }} description="Плана пока нет — сроки появятся при запуске заказа на производство" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr>
                  <th style={thStyle(token, true)}>Участок</th>
                  <th style={thStyle(token)}>Без плана</th>
                  {(board?.days ?? []).map((d) => (
                    <th key={d} style={{ ...thStyle(token), background: d === today ? token.colorPrimaryBg : undefined }}>
                      <div>{WD[dayjs(d).day()]}</div>
                      <div style={{ fontWeight: 400 }}>{dayjs(d).format("DD.MM")}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(board?.areas ?? []).map((a) => {
                  const b = backlog.get(a.code);
                  return (
                    <tr key={a.code}>
                      <td style={tdStyle(token, true)}>
                        <div style={{ fontWeight: 500 }}>{a.name}</div>
                        {a.site && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{a.site}</Typography.Text>}
                      </td>
                      <td style={tdStyle(token)}>
                        {b ? (
                          <a onClick={() => setTarget({ area: a, date: null, first: false, unplanned: true })}>
                            {fmt(b.quantity)} шт
                            <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{b.lines} стр.</div>
                          </a>
                        ) : (
                          <Typography.Text type="secondary">—</Typography.Text>
                        )}
                      </td>
                      {(board?.days ?? []).map((d, i) => {
                        const c = cell.get(`${a.code}|${d}`);
                        return (
                          <td
                            key={d}
                            onClick={() => c && setTarget({ area: a, date: d, first: i === 0, unplanned: false })}
                            style={{
                              ...tdStyle(token),
                              cursor: c ? "pointer" : undefined,
                              background: c?.overdue ? token.colorErrorBg : c ? token.colorPrimaryBg : undefined,
                            }}
                          >
                            {c ? (
                              <>
                                <div style={{ fontWeight: 600 }}>{fmt(c.quantity)}</div>
                                <div style={{ fontSize: 11, color: c.overdue ? token.colorError : token.colorTextSecondary }}>
                                  {c.overdue ? `просрочено ${fmt(c.overdue)}` : `${c.lines} стр.`}
                                </div>
                              </>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {board && board.areas.length > 0 && (
                  <tr>
                    <td style={{ ...tdStyle(token, true), fontWeight: 600 }}>Всего, шт</td>
                    <td style={tdStyle(token)} />
                    {board.days.map((d) => (
                      <td key={d} style={{ ...tdStyle(token), fontWeight: 600 }}>
                        {dayTotal(d) ? fmt(dayTotal(d)) : ""}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {target && <SlotsDrawer target={target} onClose={() => setTarget(null)} />}
    </Space>
  );
}

function thStyle(token: ReturnType<typeof theme.useToken>["token"], first = false): React.CSSProperties {
  return {
    padding: "6px 8px",
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    borderRight: `1px solid ${token.colorBorderSecondary}`,
    textAlign: first ? "left" : "center",
    fontSize: 12,
    whiteSpace: "nowrap",
    position: first ? "sticky" : undefined,
    left: first ? 0 : undefined,
    background: token.colorBgContainer,
    minWidth: first ? 200 : 64,
  };
}

function tdStyle(token: ReturnType<typeof theme.useToken>["token"], first = false): React.CSSProperties {
  return {
    ...thStyle(token, first),
    fontSize: 13,
    verticalAlign: "middle",
    background: first ? token.colorBgContainer : undefined,
  };
}

function SlotsDrawer({ target, onClose }: { target: Target; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const slotsQuery = useQuery({
    queryKey: ["plan-slots", target.area.code, target.date, target.unplanned],
    queryFn: () =>
      listPlanSlots({
        area: target.area.code,
        date_from: target.date ?? undefined,
        date_to: target.date ?? undefined,
        unplanned: target.unplanned,
        include_earlier: target.first,
      }),
  });
  const refresh = () => {
    for (const k of [["plan-board"], ["plan-slots"], ["production-orders"]]) qc.invalidateQueries({ queryKey: k });
  };
  const moveMutation = useMutation({
    mutationFn: ({ id, date }: { id: number; date: string }) => movePlanSlot(id, { date }),
    onSuccess: () => {
      refresh();
      message.success("Перенесено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось перенести")),
  });
  const splitMutation = useMutation({
    mutationFn: ({ id, date, quantity }: { id: number; date: string; quantity: number }) => splitPlanSlot(id, { date, quantity }),
    onSuccess: () => {
      refresh();
      message.success("Разделено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось разделить")),
  });
  const planMutation = useMutation({
    mutationFn: ({ lineId, date, quantity }: { lineId: number; date: string; quantity: number }) => planLine(lineId, { date, quantity }),
    onSuccess: () => {
      refresh();
      message.success("Поставлено в план");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось поставить в план")),
  });
  const noWeekend = (d: Dayjs) => d.day() === 0 || d.day() === 6;

  return (
    <Drawer
      open
      width={980}
      onClose={onClose}
      title={`${target.area.name} — ${target.unplanned ? "без плана" : `${WD[dayjs(target.date).day()]}, ${dayjs(target.date).format("DD.MM.YYYY")}`}`}
    >
      <Table<PlanSlot>
        size="small"
        rowKey={(s) => `${s.id ?? "l"}-${s.task_line_id}`}
        loading={slotsQuery.isLoading}
        dataSource={slotsQuery.data ?? []}
        pagination={false}
        scroll={{ x: "max-content" }}
        columns={[
          {
            title: "Что",
            render: (_, s) => (
              <Space direction="vertical" size={0}>
                <span>
                  {s.what}
                  {s.operation && <Typography.Text type="secondary"> · {s.operation}</Typography.Text>}
                </span>
                <Space size={4} wrap>
                  {s.order_id ? (
                    <a onClick={() => navigate(`/production-orders?order=${s.order_id}`)} style={{ fontSize: 12 }}>
                      Заказ №{s.order_id} «{s.order_name}»
                    </a>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {s.task_name}
                    </Typography.Text>
                  )}
                  {s.ship_date && <Tag style={{ margin: 0 }}>отгрузка {dayjs(s.ship_date).format("DD.MM")}</Tag>}
                  {s.overdue && <Tag color="red" style={{ margin: 0 }}>просрочено</Tag>}
                  {s.id !== null && !s.auto && <Tag style={{ margin: 0 }}>вручную</Tag>}
                </Space>
              </Space>
            ),
          },
          { title: "План, шт", render: (_, s) => <b>{fmt(s.quantity)}</b> },
          {
            title: "Строка: сделано",
            render: (_, s) => `${fmt(s.line_done)} из ${fmt(s.line_plan)}`,
          },
          ...(target.unplanned
            ? []
            : [{ title: "День", render: (_: unknown, s: PlanSlot) => (s.date ? dayjs(s.date).format("DD.MM") : "—") }]),
          {
            title: "",
            render: (_, s) =>
              canManage && (
                <Space size={4} wrap>
                  {s.id === null ? (
                    <DatePicker
                      size="small"
                      placeholder="В план на…"
                      format="DD.MM"
                      disabledDate={noWeekend}
                      onChange={(d) => d && planMutation.mutate({ lineId: s.task_line_id, date: d.format("YYYY-MM-DD"), quantity: s.quantity })}
                    />
                  ) : (
                    <>
                      <DatePicker
                        size="small"
                        placeholder="Перенести на…"
                        format="DD.MM"
                        disabledDate={noWeekend}
                        onChange={(d) => d && moveMutation.mutate({ id: s.id as number, date: d.format("YYYY-MM-DD") })}
                      />
                      {s.quantity > 1 && (
                        <SplitPopover
                          slot={s}
                          disabledDate={noWeekend}
                          onSplit={(date, quantity) => splitMutation.mutate({ id: s.id as number, date, quantity })}
                        />
                      )}
                    </>
                  )}
                </Space>
              ),
          },
        ]}
      />
    </Drawer>
  );
}

function SplitPopover({
  slot,
  onSplit,
  disabledDate,
}: {
  slot: PlanSlot;
  onSplit: (date: string, quantity: number) => void;
  disabledDate: (d: Dayjs) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<number | null>(Math.floor(slot.quantity / 2) || null);
  const [date, setDate] = useState<Dayjs | null>(null);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      title="Разделить по дням"
      content={
        <Space direction="vertical">
          <Space>
            <InputNumber min={1} max={slot.quantity - 1} value={qty} onChange={setQty} addonAfter="шт" style={{ width: 140 }} />
            <DatePicker format="DD.MM" value={date} onChange={setDate} disabledDate={disabledDate} placeholder="на день" />
          </Space>
          <Button
            type="primary"
            size="small"
            disabled={!qty || !date}
            onClick={() => {
              onSplit((date as Dayjs).format("YYYY-MM-DD"), qty as number);
              setOpen(false);
            }}
          >
            Отделить {qty ?? ""} шт на {date ? date.format("DD.MM") : "…"}
          </Button>
        </Space>
      }
    >
      <Button size="small">Разделить</Button>
    </Popover>
  );
}
