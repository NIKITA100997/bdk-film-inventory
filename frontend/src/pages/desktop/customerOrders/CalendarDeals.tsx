import { useState } from "react";
import { Button, Space, Tag, Tooltip, Typography, theme } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { getCalendarDeals, type FunnelDeal } from "../../../api/customerOrders";
import ScheduleImportModal from "../production/ScheduleImportModal";

const DAY_W = 36; // как столбец дня календаря заказов

/** Сделки Битрикса в календаре заказов (20.10): открытые сделки воронки,
 * по которым ещё нет заказа клиента, — на их «Дату отгрузки»; из сделки —
 * «Создать заказ клиента» (счёт, клиент, менеджер, дата — из сделки,
 * позиции — файлом счёта 1С). Без даты — списком под календарём сделок. */
export default function CalendarDeals({
  days,
  leftWidth,
  canCreate,
  needle,
}: {
  days: Dayjs[];
  leftWidth: number;
  canCreate: boolean;
  needle: string;
}) {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const from = days[0].format("YYYY-MM-DD");
  const to = days[days.length - 1].format("YYYY-MM-DD");
  const q = useQuery({ queryKey: ["calendar-deals", from, to], queryFn: () => getCalendarDeals(from, to), staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  const [showUndated, setShowUndated] = useState(false);
  const [creating, setCreating] = useState<FunnelDeal | null>(null);
  if (!q.data?.connected) return null;
  const hit = (d: FunnelDeal) => !needle || [d.title, d.company, d.assigned].some((v) => (v ?? "").toLowerCase().includes(needle));
  const dated = q.data.dated.filter(hit).sort((a, b) => (a.ship_date ?? "").localeCompare(b.ship_date ?? ""));
  const undated = q.data.undated.filter(hit);
  if (!dated.length && !undated.length) return null;

  const createBtn = (d: FunnelDeal) =>
    canCreate ? (
      <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setCreating(d)}>
        Создать заказ клиента
      </Button>
    ) : null;
  const head = (d: FunnelDeal) => (
    <div style={{ display: "grid", gap: 2 }}>
      <Space size={4} wrap>
        {d.url ? (
          <a href={d.url} target="_blank" rel="noreferrer">
            <b>{d.title}</b>
          </a>
        ) : (
          <b>{d.title}</b>
        )}
        <Tag style={{ marginInlineEnd: 0 }}>{d.stage_name}</Tag>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {[d.company, d.assigned, d.amount ? `${Math.round(d.amount).toLocaleString("ru-RU")} ₽` : null].filter(Boolean).join(" · ")}
      </Typography.Text>
      {createBtn(d)}
    </div>
  );

  return (
    <div style={{ border: `1px dashed ${token.colorWarningBorder}`, borderRadius: token.borderRadius, background: token.colorBgContainer, padding: 8 }}>
      <Space wrap size={[12, 4]}>
        <Typography.Text strong>Сделки Битрикса без заказа клиента</Typography.Text>
        <Typography.Text type="secondary">
          с датой отгрузки в периоде: {dated.length} · без даты: {undated.length}
        </Typography.Text>
        <Button size="small" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Скрыть" : "Показать на календаре"}
        </Button>
        {undated.length > 0 && (
          <Button size="small" onClick={() => setShowUndated(!showUndated)} aria-expanded={showUndated}>
            {showUndated ? "Скрыть без даты" : `Без даты (${undated.length})`}
          </Button>
        )}
      </Space>
      {open && dated.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, zIndex: 2, background: token.colorBgContainer, minWidth: leftWidth, textAlign: "left", padding: "2px 8px" }}>
                  Сделка
                </th>
                {days.map((d) => (
                  <th key={d.format("YYYY-MM-DD")} style={{ width: DAY_W, minWidth: DAY_W, fontWeight: d.date() === 1 || d.day() === 1 ? 600 : 400, padding: "2px 0", textAlign: "center" }}>
                    <div style={{ color: token.colorTextTertiary }}>{["вс", "пн", "вт", "ср", "чт", "пт", "сб"][d.day()]}</div>
                    <div>{d.format(d.date() === 1 ? "D MMM" : "D")}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dated.map((d) => (
                <tr key={d.id} style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}>
                  <td style={{ position: "sticky", left: 0, zIndex: 1, background: token.colorBgContainer, minWidth: leftWidth, maxWidth: leftWidth, padding: "4px 8px", verticalAlign: "top" }}>
                    {head(d)}
                  </td>
                  {days.map((day) => {
                    const key = day.format("YYYY-MM-DD");
                    const on = d.ship_date === key;
                    return (
                      <td key={key} style={{ width: DAY_W, minWidth: DAY_W, height: 30, borderLeft: `1px solid ${token.colorBorderSecondary}`, padding: 0, textAlign: "center", background: day.day() === 0 || day.day() === 6 ? token.colorFillQuaternary : undefined }}>
                        {on && (
                          <Tooltip title={`Отгрузка по сделке ${dayjs(key).format("DD.MM.YYYY")} — заказа клиента ещё нет`}>
                            <span
                              style={{
                                display: "inline-block",
                                width: 18,
                                height: 14,
                                border: `2px dashed ${token.colorWarning}`,
                                borderRadius: 3,
                              }}
                              aria-label={`отгрузка ${dayjs(key).format("DD.MM")}`}
                            />
                          </Tooltip>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showUndated && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8, marginTop: 8 }}>
          {undated.map((d) => (
            <div key={d.id} style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadius, padding: 6 }}>
              {head(d)}
            </div>
          ))}
        </div>
      )}
      {creating && (
        <ScheduleImportModal
          target="customer"
          fromDeal={{
            id: creating.id,
            title: creating.title,
            invoice: creating.invoice,
            company: creating.company,
            amount: creating.amount,
            assignedBx: creating.assigned_bx,
            shipDate: creating.ship_date ?? null,
          }}
          onClose={() => setCreating(null)}
          onCustomerCreated={(ids) => {
            setCreating(null);
            qc.invalidateQueries({ queryKey: ["calendar-deals"] });
            qc.invalidateQueries({ queryKey: ["order-calendar"] });
            if (ids.length === 1) navigate(`/customer-orders/${ids[0]}`);
          }}
        />
      )}
    </div>
  );
}
