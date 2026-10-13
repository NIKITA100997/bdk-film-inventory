import { useMemo, useState } from "react";
import { Alert, Button, Card, Checkbox, DatePicker, Input, Modal, Select, Space, Tag, Tooltip, Typography, message, theme } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import { deleteCalendarDay, listCalendarDays, rescheduleOpenOrders, setCalendarDay, type CalendarDay } from "../../../api/calendar";
import { listAreas } from "../../../api/areas";
import { useAuth } from "../../../auth/AuthContext";
import { apiErrorMessage } from "../../../utils/apiError";
import { hasPerm } from "../../../auth/permissions";

/** Производственный календарь (12.10): пятидневка с праздниками; день можно
 * сделать рабочим или нерабочим для всех участков или для одного (суббота
 * для отдельных участков, отключили свет). Сроки операций считаются по нему;
 * после правки — «Пересчитать сроки» открытых заказов. */
export default function ProductionCalendar() {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = hasPerm(user, "production_tasks.manage");
  const [month, setMonth] = useState<Dayjs>(() => dayjs().startOf("month"));
  const from = month.startOf("week");
  const to = month.endOf("month").endOf("week");
  const daysQuery = useQuery({
    queryKey: ["production-calendar", from.format("YYYY-MM-DD"), to.format("YYYY-MM-DD")],
    queryFn: () => listCalendarDays(from.format("YYYY-MM-DD"), to.format("YYYY-MM-DD")),
  });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarDay[]>();
    for (const c of daysQuery.data ?? []) m.set(c.day, [...(m.get(c.day) ?? []), c]);
    return m;
  }, [daysQuery.data]);
  const [edit, setEdit] = useState<Dayjs | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [work, setWork] = useState(true);
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["production-calendar"] });
  const save = useMutation({
    mutationFn: () => setCalendarDay({ day: edit!.format("YYYY-MM-DD"), area, is_workday: work, note: note.trim() || null }),
    onSuccess: () => {
      invalidate();
      setDirty(true);
      setEdit(null);
      message.success("День сохранён");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteCalendarDay(id),
    onSuccess: () => {
      invalidate();
      setDirty(true);
    },
  });
  const resched = useMutation({
    mutationFn: rescheduleOpenOrders,
    onSuccess: (r) => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      message.success(`Сроки пересчитаны: заказов ${r.orders}, не успевают ${r.late}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось пересчитать")),
  });

  const openDay = (d: Dayjs) => {
    if (!canManage) return;
    const global = (byDay.get(d.format("YYYY-MM-DD")) ?? []).find((c) => !c.area);
    setEdit(d);
    setArea(null);
    setWork(global ? global.is_workday : d.day() === 0 || d.day() === 6);
    setNote("");
  };

  const weeks: Dayjs[][] = [];
  for (let w = from; w.isBefore(to); w = w.add(1, "week")) weeks.push(Array.from({ length: 7 }, (_, i) => w.add(i, "day")));

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%", maxWidth: 1100 }}>
      <Card size="small" title="Производственный календарь">
        <Space wrap>
          <Button onClick={() => setMonth(month.subtract(1, "month"))}>←</Button>
          <DatePicker picker="month" value={month} onChange={(v) => v && setMonth(v.startOf("month"))} format="MMMM YYYY" allowClear={false} />
          <Button onClick={() => setMonth(month.add(1, "month"))}>→</Button>
          {canManage && (
            <Button type={dirty ? "primary" : "default"} loading={resched.isPending} onClick={() => resched.mutate()}>
              Пересчитать сроки открытых заказов
            </Button>
          )}
        </Space>
        <Typography.Paragraph type="secondary" style={{ margin: "10px 0 0" }}>
          Пятидневка с праздниками. Нажмите на день, чтобы сделать его рабочим или нерабочим — для всех участков или только для одного:
          рабочая суббота, отключили свет. Сроки операций считаются по календарю.
        </Typography.Paragraph>
        {dirty && <Alert style={{ marginTop: 8 }} type="info" showIcon message="Календарь изменён — пересчитайте сроки открытых заказов." />}
      </Card>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 700, tableLayout: "fixed" }}>
          <thead>
            <tr>
              {["пн", "вт", "ср", "чт", "пт", "сб", "вс"].map((w) => (
                <th key={w} style={{ padding: 6, color: token.colorTextSecondary, fontWeight: 600 }}>
                  {w}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((wk) => (
              <tr key={wk[0].format("YYYY-MM-DD")}>
                {wk.map((d) => {
                  const key = d.format("YYYY-MM-DD");
                  const list = byDay.get(key) ?? [];
                  const global = list.find((c) => !c.area);
                  const weekend = d.day() === 0 || d.day() === 6;
                  const isWork = global ? global.is_workday : !weekend;
                  const other = !d.isSame(month, "month");
                  return (
                    <td
                      key={key}
                      onClick={() => openDay(d)}
                      style={{
                        verticalAlign: "top",
                        height: 92,
                        padding: 6,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        background: isWork ? token.colorBgContainer : token.colorFillSecondary,
                        opacity: other ? 0.45 : 1,
                        cursor: canManage ? "pointer" : "default",
                        outline: key === dayjs().format("YYYY-MM-DD") ? `2px solid ${token.colorPrimary}` : undefined,
                        outlineOffset: -2,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <b style={{ color: isWork ? token.colorText : token.colorTextTertiary }}>{d.date()}</b>
                        {global && (
                          <Tag color={global.is_workday ? "green" : "red"} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                            {global.is_workday ? "рабочий" : "нерабочий"}
                          </Tag>
                        )}
                      </div>
                      {global?.note && (
                        <div style={{ fontSize: 11, color: token.colorTextSecondary, lineHeight: 1.3 }}>{global.note}</div>
                      )}
                      {list
                        .filter((c) => c.area)
                        .map((c) => (
                          <Tooltip key={c.id} title={c.note ?? ""}>
                            <Tag
                              color={c.is_workday ? "green" : "red"}
                              closable={canManage}
                              onClose={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                remove.mutate(c.id);
                              }}
                              onClick={(e) => e.stopPropagation()}
                              style={{ fontSize: 11, marginTop: 2, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}
                            >
                              {c.is_workday ? "+ " : "− "}
                              {c.area_name}
                            </Tag>
                          </Tooltip>
                        ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        open={!!edit}
        title={edit ? edit.format("dddd, D MMMM YYYY") : ""}
        okText="Сохранить"
        cancelText="Отмена"
        onCancel={() => setEdit(null)}
        okButtonProps={{ loading: save.isPending }}
        onOk={() => save.mutate()}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Select
            allowClear
            placeholder="Все участки"
            style={{ width: "100%" }}
            value={area ?? undefined}
            onChange={(v) => setArea(v ?? null)}
            options={areaOptions}
            showSearch
            optionFilterProp="label"
          />
          <Checkbox checked={work} onChange={(e) => setWork(e.target.checked)}>
            Рабочий день {area ? "для этого участка" : "для всех"}
          </Checkbox>
          <Input placeholder="Пометка: праздник, рабочая суббота, отключили свет…" value={note} onChange={(e) => setNote(e.target.value)} />
        </Space>
      </Modal>
    </Space>
  );
}
