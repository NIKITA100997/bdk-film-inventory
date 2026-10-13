import { useState } from "react";
import { Alert, Button, Card, DatePicker, Empty, Input, Modal, Space, Spin, Table, Tag, Tooltip, Typography, message, theme } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import {
  approveWeeklyPlan,
  getWeeklyPlan,
  launchWeeklyPlan,
  returnWeeklyPlan,
  submitWeeklyPlan,
  type PlanOrder,
  type WeeklyPlan as Plan,
} from "../../../api/weeklyPlan";
import { PRIORITY_COLOR, PRIORITY_LABEL } from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";
import { exportBook } from "../../../utils/excel";
import { LaggingCard } from "./OrderControl";

const STATUS: Record<Plan["status"], [string, string]> = {
  draft: ["черновик", "default"],
  submitted: ["на утверждении", "gold"],
  approved: ["утверждён", "green"],
  changed: ["изменён после утверждения", "volcano"],
};
const d = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM") : "—");

/** План недели (12.10): заказы с обещанной готовностью на неделю, загрузка
 * участков против мощности, утверждение руководителем (и вперёд), журнал
 * изменений, запуск недели одной кнопкой. */
export default function WeeklyPlan() {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const week = dayjs(params.get("week") ?? undefined).startOf("week");
  const wk = week.format("YYYY-MM-DD");
  const setWeek = (w: Dayjs) => setParams({ week: w.startOf("week").format("YYYY-MM-DD") }, { replace: true });
  const q = useQuery({ queryKey: ["weekly-plan", wk], queryFn: () => getWeeklyPlan(wk) });
  const [dialog, setDialog] = useState<"submit" | "approve" | "return" | null>(null);
  const [comment, setComment] = useState("");

  const act = useMutation({
    mutationFn: async (kind: "submit" | "approve" | "return") => {
      const c = comment.trim() || null;
      if (kind === "submit") return submitWeeklyPlan(wk, c);
      if (kind === "approve") return approveWeeklyPlan(wk, c);
      return returnWeeklyPlan(wk, c ?? "");
    },
    onSuccess: (p, kind) => {
      qc.setQueryData(["weekly-plan", wk], p);
      setDialog(null);
      setComment("");
      message.success(kind === "submit" ? "План отправлен на утверждение" : kind === "approve" ? `План утверждён, версия ${p.version}` : "План возвращён");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не получилось")),
  });
  const launch = useMutation({
    mutationFn: () => launchWeeklyPlan(wk),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["weekly-plan"] });
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      if (r.launched.length) message.success(`Запущено заказов: ${r.launched.length}`);
      if (r.failed.length) Modal.warning({ title: "Не запустились — остались черновиками", content: r.failed.join("\n") });
      if (!r.launched.length && !r.failed.length) message.info("Принятых незапущенных заказов на неделе нет");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось запустить")),
  });

  const p = q.data;
  const [statusLabel, statusColor] = p ? STATUS[p.status] : ["", "default"];
  const toLaunch = (p?.orders ?? []).filter((o) => o.state === "принят" || o.state === "собран").length;

  const orderCols = [
    {
      title: "Заказ",
      render: (_: unknown, o: PlanOrder) => (
        <Space size={4} wrap>
          {o.priority > 0 && <Tag color={PRIORITY_COLOR[o.priority]}>{PRIORITY_LABEL[o.priority]}</Tag>}
          {o.kind === "co" ? (
            <Link to={`/customer-orders/${o.id}`}>Заказ клиента: {o.name}</Link>
          ) : (
            <Link to={`/production-orders/${o.id}`}>
              №{o.id} «{o.name}»
            </Link>
          )}
          {o.customer && <Typography.Text type="secondary">· {o.customer}</Typography.Text>}
          {p && p.version > 0 && !o.in_approved && <Tag color="volcano">новый после утверждения</Tag>}
          {o.moved && <Tag color="orange">даты изменены</Tag>}
        </Space>
      ),
    },
    { title: "Состояние", render: (_: unknown, o: PlanOrder) => <Tag color={o.state === "запущен" ? "blue" : o.state === "принят" || o.state === "собран" ? "cyan" : "gold"}>{o.state}</Tag> },
    { title: "Шт", align: "right" as const, dataIndex: "qty" },
    { title: "Готовность", render: (_: unknown, o: PlanOrder) => d(o.promised_ready) },
    { title: "Отгрузка", render: (_: unknown, o: PlanOrder) => d(o.ship_date) },
    {
      title: "По плану",
      render: (_: unknown, o: PlanOrder) =>
        o.plan_finish ? <Tag color={o.plan_late ? "red" : "green"}>{d(o.plan_finish)}{o.plan_late ? " — позже" : ""}</Tag> : "—",
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small" title="План недели">
        <Space wrap size={[12, 8]}>
          <Space size={4}>
            <Button onClick={() => setWeek(week.subtract(1, "week"))}>←</Button>
            <DatePicker picker="week" value={week} allowClear={false} format={(v) => `${v.startOf("week").format("DD.MM")} – ${v.endOf("week").format("DD.MM.YYYY")}`} onChange={(v) => v && setWeek(v)} />
            <Button onClick={() => setWeek(week.add(1, "week"))}>→</Button>
            <Button onClick={() => setWeek(dayjs())}>Эта неделя</Button>
          </Space>
          {p && (
            <>
              <Tag color={statusColor}>{statusLabel}{p.version ? ` · версия ${p.version}` : ""}</Tag>
              {p.approved_by_name && <Typography.Text type="secondary">утвердил {p.approved_by_name} {p.approved_at ? dayjs(p.approved_at).format("DD.MM HH:mm") : ""}</Typography.Text>}
            </>
          )}
        </Space>
        {p && (
          <Space wrap style={{ marginTop: 10 }}>
            {p.can_manage && (p.status === "draft" || p.status === "changed") && (
              <Button type="primary" onClick={() => setDialog("submit")}>
                Отправить на утверждение
              </Button>
            )}
            {p.can_approve && (p.status === "submitted" || p.status === "changed") && (
              <>
                <Button type="primary" onClick={() => setDialog("approve")}>
                  Утвердить
                </Button>
                <Button danger onClick={() => setDialog("return")}>
                  Вернуть
                </Button>
              </>
            )}
            <Button
              onClick={() =>
                exportBook(`План недели ${dayjs(p.week_start).format("DD.MM.YYYY")}`, [
                  {
                    name: "Заказы",
                    rows: p.orders.map((o) => ({
                      id: o.id, name: o.name, customer: o.customer ?? "", priority: PRIORITY_LABEL[o.priority], state: o.state, qty: o.qty,
                      ready: d(o.promised_ready), ship: d(o.ship_date), plan: d(o.plan_finish), late: o.plan_late ? "не успевает" : "",
                    })),
                    columns: [
                      { key: "id", header: "№" }, { key: "name", header: "Заказ" }, { key: "customer", header: "Клиент" },
                      { key: "priority", header: "Приоритет" }, { key: "state", header: "Состояние" }, { key: "qty", header: "Шт" },
                      { key: "ready", header: "Готовность" }, { key: "ship", header: "Отгрузка" }, { key: "plan", header: "По плану" },
                      { key: "late", header: "" },
                    ],
                  },
                  {
                    name: "Загрузка участков",
                    rows: p.areas.map((a) => ({
                      name: a.name,
                      ...Object.fromEntries(p.days.map((day, i) => [day, a.capacity[i] ? `${a.by_day[i]} / ${a.capacity[i]}` : a.by_day[i]])),
                    })),
                    columns: [{ key: "name", header: "Участок" }, ...p.days.map((day) => ({ key: day, header: dayjs(day).format("dd DD.MM") }))],
                  },
                ])
              }
            >
              Excel
            </Button>
            <Button onClick={() => window.print()}>Печать</Button>
            {p.can_manage && p.status === "approved" && (
              <Button
                loading={launch.isPending}
                disabled={!toLaunch}
                onClick={() =>
                  Modal.confirm({
                    title: `Запустить ${toLaunch} принятых заказов недели?`,
                    content: "Задания участкам создаются как при обычном запуске; ламинация панелей — на Фабрику при партии от порога, иначе по маршруту. Что не запустится — останется черновиком с причиной.",
                    okText: "Запустить",
                    cancelText: "Отмена",
                    onOk: () => launch.mutateAsync(),
                  })
                }
              >
                Запустить неделю ({toLaunch})
              </Button>
            )}
          </Space>
        )}
      </Card>

      {q.isLoading || !p ? (
        <Spin />
      ) : (
        <>
          {p.status === "changed" && (
            <Alert type="warning" showIcon message="План изменён после утверждения — нужно утвердить заново" description="Что изменилось — в журнале ниже." />
          )}
          {p.removed.length > 0 && <Alert type="info" showIcon message={`Ушли с недели после утверждения: ${p.removed.join(", ")}`} />}
          <Card size="small" title={`Заказы недели — ${p.orders.length}`}>
            <Table<PlanOrder> size="small" rowKey="key" pagination={false} dataSource={p.orders} columns={orderCols} locale={{ emptyText: "На этой неделе нет заказов с готовностью" }} />
          </Card>
          {p.requests.length > 0 && (
            <Card size="small" title={`Заявки на эту неделю ждут приёма — ${p.requests.length}`}>
              <Table<PlanOrder> size="small" rowKey="key" pagination={false} dataSource={p.requests} columns={orderCols} />
            </Card>
          )}
          <Card size="small" title="Загрузка участков, шт">
            {p.areas.length === 0 ? (
              <Empty description="На неделе нет работ по участкам" />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "4px 8px" }}>Участок</th>
                      {p.days.map((day) => (
                        <th key={day} style={{ padding: "4px 8px", textAlign: "right", color: token.colorTextSecondary }}>
                          {dayjs(day).format("dd D.MM")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.areas.map((a) => (
                      <tr key={a.area} style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}>
                        <td style={{ padding: "4px 8px" }}>{a.name}</td>
                        {a.by_day.map((v, i) => {
                          const cap = a.capacity[i];
                          const off = cap === 0;
                          const over = cap != null && cap > 0 && v > cap;
                          return (
                            <td
                              key={i}
                              style={{
                                padding: "4px 8px",
                                textAlign: "right",
                                background: off ? token.colorFillSecondary : over ? token.colorErrorBg : undefined,
                                color: over ? token.colorError : v ? token.colorText : token.colorTextQuaternary,
                                fontWeight: over ? 600 : 400,
                              }}
                            >
                              <Tooltip title={off ? "нерабочий день" : cap ? `мощность ${cap}` : "мощность не задана"}>
                                {v ? v : off ? "вых" : "·"}
                                {cap ? <span style={{ color: token.colorTextTertiary, fontWeight: 400 }}> /{cap}</span> : null}
                              </Tooltip>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0", fontSize: 12 }}>
              Запущенные — по дням плана, принятые — по расчёту сроков. Красное — больше мощности; «вых» — нерабочий день по календарю.
            </Typography.Paragraph>
          </Card>
          <LaggingCard canManage={p.can_manage} />
          <Card size="small" title="Журнал плана">
            {p.events.length === 0 ? (
              <Typography.Text type="secondary">Пока пусто</Typography.Text>
            ) : (
              <Space direction="vertical" size={4}>
                {p.events.map((e, i) => (
                  <span key={i}>
                    <Typography.Text type="secondary">{dayjs(e.created_at).format("DD.MM HH:mm")}</Typography.Text> {e.text}
                    {e.user_name ? <Typography.Text type="secondary"> — {e.user_name}</Typography.Text> : null}
                  </span>
                ))}
              </Space>
            )}
          </Card>
        </>
      )}

      <Modal
        open={!!dialog}
        title={dialog === "submit" ? "Отправить план на утверждение" : dialog === "approve" ? "Утвердить план" : "Вернуть план"}
        okText={dialog === "submit" ? "Отправить" : dialog === "approve" ? "Утвердить" : "Вернуть"}
        cancelText="Отмена"
        okButtonProps={{ loading: act.isPending, disabled: dialog === "return" && !comment.trim(), danger: dialog === "return" }}
        onCancel={() => setDialog(null)}
        onOk={() => dialog && act.mutate(dialog)}
      >
        <Input.TextArea
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={dialog === "return" ? "Что поправить (обязательно)" : "Комментарий (необязательно)"}
        />
      </Modal>
    </Space>
  );
}
