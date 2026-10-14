import { Alert, Button, Descriptions, Drawer, Empty, Progress, Space, Tag, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import type { CalendarRow, CustomerOrder } from "../../api/customerOrders";
import { PRIORITY_COLOR, PRIORITY_LABEL } from "../../api/productionOrders";

const fmt = (d: string | null | undefined) => (d ? dayjs(d).format("DD.MM.YYYY") : "—");
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Карточка заказа в календаре (14.10) — что нужно продажнику, не уходя из
 * календаря: что заказано, сроки и прогноз, ход по участкам, отставание,
 * когда последний раз работали, комментарий. */
export default function OrderCalendarDrawer({
  co,
  cal,
  stateLabel,
  stateColor,
  onClose,
}: {
  co: CustomerOrder | null;
  cal: CalendarRow | null;
  stateLabel: string;
  stateColor: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const areas = cal?.areas ?? [];
  const need = areas.reduce((x, a) => x + a.need, 0);
  const done = areas.reduce((x, a) => x + Math.min(a.done, a.need), 0);
  const pct = need > 0 ? Math.round((100 * done) / need) : null;
  const promised = co?.promised_ready ?? cal?.promised_ready ?? null;
  const ship = co?.ship_date ?? cal?.ship_date ?? null;
  const planFinish = co?.plan_finish ?? cal?.plan_finish ?? null;
  const late = co ? co.plan_late : !!(planFinish && (promised ?? ship) && planFinish > (promised ?? ship)!);
  const overdue = cal?.overdue ?? 0;
  const note = co?.note ?? cal?.note ?? null;
  const items: [string, number][] = co ? co.lines.map((l) => [l.item_name, l.quantity]) : ((cal?.items ?? []) as [string, number][]);
  const title = co ? `Счёт ${co.invoice_no}` : cal?.title ?? "";
  const open = () => {
    onClose();
    navigate(co ? `/customer-orders/${co.id}` : `/production-orders?order=${cal!.id}`);
  };
  return (
    <Drawer
      open
      width={Math.min(560, window.innerWidth)}
      onClose={onClose}
      title={
        <Space wrap size={6}>
          <span>{title}</span>
          <Tag color={stateColor}>{stateLabel}</Tag>
          {co && co.priority > 0 && <Tag color={PRIORITY_COLOR[co.priority]}>{PRIORITY_LABEL[co.priority]}</Tag>}
        </Space>
      }
      extra={
        <Button type="primary" onClick={open}>
          Открыть заказ →
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {late && (
          <Alert
            type="error"
            showIcon
            message={`По плану готово ${fmt(planFinish)} — позже обещанного ${fmt(promised ?? ship)}`}
          />
        )}
        {overdue > 0 && (
          <Alert type="warning" showIcon message={`Не сделано по плану прошедших дней: ${r1(overdue)} шт`} />
        )}
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Клиент">{(co?.customer ?? cal?.customer) || "—"}</Descriptions.Item>
          {co && <Descriptions.Item label="Менеджер">{co.manager_name ?? "—"}</Descriptions.Item>}
          {co && (co.ship_from || co.ship_to) && (
            <Descriptions.Item label="Вилка клиента">
              {fmt(co.ship_from)} — {fmt(co.ship_to)}
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Обещанная готовность">{fmt(promised)}</Descriptions.Item>
          <Descriptions.Item label="Отгрузка">{fmt(ship)}</Descriptions.Item>
          <Descriptions.Item label="Готово по плану">
            <Typography.Text type={late ? "danger" : undefined}>{planFinish ? fmt(planFinish) : "плана по дням нет"}</Typography.Text>
          </Descriptions.Item>
          {co?.ready_fact && <Descriptions.Item label="Готово фактически">{fmt(co.ready_fact)}</Descriptions.Item>}
          {co && (
            <Descriptions.Item label="Изделия">
              заказано {co.qty} шт · на складе ГП {co.received} · отгружено {co.shipped}
              {co.last_shipped_at ? ` (последняя отгрузка ${fmt(co.last_shipped_at)})` : ""}
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Последняя работа">{cal?.last_fact ? fmt(cal.last_fact) : "отчётов ещё нет"}</Descriptions.Item>
          {note && <Descriptions.Item label="Комментарий">{note}</Descriptions.Item>}
        </Descriptions>

        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            Ход по участкам {pct != null && <Typography.Text type="secondary">· всего {pct}%</Typography.Text>}
          </Typography.Title>
          {areas.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="В производство ещё не запущен" />
          ) : (
            <Space direction="vertical" style={{ width: "100%" }} size={6}>
              {areas.map((a) => (
                <div key={a.area}>
                  <Space style={{ width: "100%", justifyContent: "space-between" }}>
                    <span>{a.area_name}</span>
                    <Typography.Text type="secondary" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {r1(a.done)} из {r1(a.need)}
                      {a.overdue > 0 ? ` · отстаёт на ${r1(a.overdue)}` : ""}
                    </Typography.Text>
                  </Space>
                  <Progress
                    percent={a.need > 0 ? Math.min(100, Math.round((100 * a.done) / a.need)) : 0}
                    size="small"
                    status={a.done >= a.need - 1e-6 ? "success" : a.overdue > 0 ? "exception" : "active"}
                  />
                </div>
              ))}
            </Space>
          )}
        </div>

        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            Что в заказе {items.length > 0 && <Typography.Text type="secondary">· {items.length} поз.</Typography.Text>}
          </Typography.Title>
          {items.length === 0 ? (
            <Typography.Text type="secondary">—</Typography.Text>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {items.slice(0, 40).map(([n, q], i) => (
                  <tr key={i} style={{ borderTop: i ? "1px solid rgba(128,128,128,.15)" : undefined }}>
                    <td style={{ padding: "3px 0" }}>{n}</td>
                    <td style={{ padding: "3px 0", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{r1(q)} шт</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {items.length > 40 && <Typography.Text type="secondary">и ещё {items.length - 40} — в заказе</Typography.Text>}
        </div>
      </Space>
    </Drawer>
  );
}
