import { useState } from "react";
import { Alert, DatePicker, Form, Input, InputNumber, Modal, Segmented, Select, Space, Table, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import ItemLinesEditor, { emptyLine, type LineDraft } from "../../../components/ItemLinesEditor";
import {
  createCustomerOrder,
  moveCustomerOrder,
  updateCustomerOrder,
  type CustomerOrder,
} from "../../../api/customerOrders";
import { DATE_CHANGE_REASONS, type PlanCheck } from "../../../api/productionOrders";
import { useAuth } from "../../../auth/AuthContext";
import { hasPerm } from "../../../auth/permissions";
import { apiErrorMessage } from "../../../utils/apiError";

export const fmt = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "—");
export const fmtShort = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM") : "…");
const iso = (v: Dayjs | null | undefined) => (v ? v.format("YYYY-MM-DD") : null);

/** Права на заказы клиентов: производство (принимает, двигает даты,
 * собирает запуск) и менеджер-продажник (заводит, отправляет, двигает
 * вилку до приёма). */
export function useCustomerOrderRights() {
  const { user } = useAuth();
  const production = hasPerm(user, "production_tasks.manage");
  const manager = hasPerm(user, "orders.request");
  return { production, canEdit: production || manager };
}

/** Можно ли сейчас править заказ этому человеку (как на сервере). */
export const editableBy = (o: CustomerOrder, production: boolean) =>
  o.status !== "cancelled" && (production || o.status === "draft" || o.status === "returned");

/** Заказ клиента — шапка счёта и позиции. Менеджер — вилка отгрузки
 * («когда клиент готов забрать»); твёрдые даты ставит производство при
 * приёме. */
export function CustomerOrderModal({ order, onClose, onSaved }: { order: CustomerOrder | null; onClose: () => void; onSaved: (o: CustomerOrder) => void }) {
  const qc = useQueryClient();
  const [invoiceNo, setInvoiceNo] = useState(order?.invoice_no ?? "");
  const [invoiceDate, setInvoiceDate] = useState<Dayjs | null>(order?.invoice_date ? dayjs(order.invoice_date) : null);
  const [customer, setCustomer] = useState(order?.customer ?? "");
  const [amount, setAmount] = useState<number | null>(order?.amount_rub ?? null);
  const [priority, setPriority] = useState(order?.priority ?? 0);
  const [win, setWin] = useState<[Dayjs | null, Dayjs | null]>([
    order?.ship_from ? dayjs(order.ship_from) : null,
    order?.ship_to ? dayjs(order.ship_to) : null,
  ]);
  const [note, setNote] = useState(order?.note ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    order ? order.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity, note: l.note ?? "", invoice_no: "", options: l.options ?? null })) : [emptyLine()],
  );
  const launched = (order?.launched ?? 0) > 0;
  const mutation = useMutation({
    mutationFn: () => {
      const p = {
        invoice_no: invoiceNo.trim(),
        invoice_date: iso(invoiceDate),
        customer: customer.trim() || null,
        amount_rub: amount,
        priority,
        ship_from: iso(win[0]),
        ship_to: iso(win[1]),
        note: note.trim() || null,
        lines: lines.map((l) => ({ item_id: l.item_id as number, quantity: l.quantity as number, note: l.note.trim() || null, options: l.options ?? null })),
      };
      return order ? updateCustomerOrder(order.id, p) : createCustomerOrder(p);
    },
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      qc.setQueryData(["customer-order", o.id], o);
      message.success(order ? "Заказ сохранён" : "Заказ клиента создан");
      onSaved(o);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить заказ")),
  });
  const invalid = !invoiceNo.trim() || lines.length === 0 || lines.some((l) => !l.item_id || !l.quantity || l.quantity <= 0);
  return (
    <Modal
      open
      width={820}
      title={order ? `Заказ клиента: счёт ${order.invoice_no}` : "Новый заказ клиента"}
      okText={order ? "Сохранить" : "Создать"}
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ disabled: invalid, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
    >
      <Form layout="vertical">
        <Space size={12} wrap style={{ display: "flex" }}>
          <Form.Item label="№ счёта 1С" required>
            <Input style={{ width: 160 }} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </Form.Item>
          <Form.Item label="Дата счёта">
            <DatePicker format="DD.MM.YYYY" value={invoiceDate} onChange={setInvoiceDate} />
          </Form.Item>
          <Form.Item label="Клиент">
            <Input style={{ width: 280 }} placeholder="Как в счёте 1С" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </Form.Item>
        </Space>
        <Space size={12} wrap style={{ display: "flex" }}>
          <Form.Item label="Вилка отгрузки" extra="Когда клиент готов забрать: с — по. Нужна для отправки в производство">
            <DatePicker.RangePicker
              format="DD.MM.YYYY"
              allowEmpty={[true, false]}
              value={win}
              onChange={(v) => setWin([v?.[0] ?? null, v?.[1] ?? null])}
            />
          </Form.Item>
          <Form.Item label="Сумма счёта, ₽">
            <InputNumber min={0} style={{ width: 150 }} value={amount} onChange={(v) => setAmount(v ?? null)} />
          </Form.Item>
          <Form.Item label="Приоритет">
            <Segmented
              value={priority}
              onChange={(v) => setPriority(v as number)}
              options={[
                { value: 0, label: "Обычный" },
                { value: 1, label: "Высокий" },
                { value: 2, label: "Срочный" },
              ]}
            />
          </Form.Item>
        </Space>
        <Form.Item label="Комментарий">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Form.Item>
        {launched && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 8 }}
            message="Часть заказа уже в запуске: запущенные позиции не убираются и не уменьшаются ниже запущенного — это делается в заказе на производство"
          />
        )}
        <ItemLinesEditor lines={lines} onChange={setLines} />
      </Form>
    </Modal>
  );
}

/** Перенос дат заказа клиента. Менеджер — вилку, пока заказ не принят;
 * производство — обещанные готовность и отгрузку (после приёма — только с
 * причиной, попадает в историю и менеджеру), факт готовности. preset —
 * даты, куда перетащили в графике отгрузок. */
export function MoveDatesModal({
  order,
  preset,
  onClose,
}: {
  order: CustomerOrder;
  preset?: { ship_from?: string | null; ship_to?: string | null; ship_date?: string | null; ready_date?: string | null };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { production } = useCustomerOrderRights();
  const d = (v: string | null | undefined) => (v ? dayjs(v) : null);
  const windowOpen = production || ["draft", "returned", "submitted"].includes(order.status);
  const [win, setWin] = useState<[Dayjs | null, Dayjs | null]>([
    d(preset?.ship_from !== undefined ? preset.ship_from : order.ship_from),
    d(preset?.ship_to !== undefined ? preset.ship_to : order.ship_to),
  ]);
  const [ready, setReady] = useState<Dayjs | null>(d(preset?.ready_date ?? order.promised_ready));
  const [ship, setShip] = useState<Dayjs | null>(d(preset?.ship_date ?? order.ship_date));
  const [fact, setFact] = useState<Dayjs | null>(d(order.ready_fact));
  const [reason, setReason] = useState<string | undefined>();
  const [comment, setComment] = useState("");
  const committed = order.status === "accepted";
  const moved = (iso(ready) ?? order.promised_ready) !== order.promised_ready || (iso(ship) ?? order.ship_date) !== order.ship_date;
  const winChanged = iso(win[0]) !== order.ship_from || iso(win[1]) !== order.ship_to;
  const mutation = useMutation({
    mutationFn: () =>
      moveCustomerOrder(order.id, {
        ...(winChanged ? { ship_from: iso(win[0]), ship_to: iso(win[1]) } : {}),
        ...(production
          ? {
              ready_date: iso(ready),
              ship_date: iso(ship),
              ready_fact: fact && iso(fact) !== order.ready_fact ? iso(fact) : null,
              reason: reason ?? null,
              comment: comment.trim() || null,
            }
          : {}),
      }),
    onSuccess: (o) => {
      qc.setQueryData(["customer-order", o.id], o);
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      qc.invalidateQueries({ queryKey: ["weekly-plan"] });
      message.success("Даты сохранены");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить даты")),
  });
  const reasonMissing = production && moved && committed && (!reason || (reason === "other" && !comment.trim()));
  return (
    <Modal
      open
      title={`Даты заказа: счёт ${order.invoice_no}${order.customer ? ` · ${order.customer}` : ""}`}
      okText="Сохранить"
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{
        loading: mutation.isPending,
        disabled: reasonMissing || (!!ready && !!ship && ready.isAfter(ship)) || (!!win[0] && !!win[1] && win[0].isAfter(win[1])),
      }}
      onOk={() => mutation.mutate()}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space wrap>
          <span>Вилка клиента:</span>
          <DatePicker.RangePicker
            format="DD.MM.YYYY"
            allowEmpty={[true, false]}
            disabled={!windowOpen}
            value={win}
            onChange={(v) => setWin([v?.[0] ?? null, v?.[1] ?? null])}
          />
        </Space>
        {!windowOpen && <Typography.Text type="secondary">Заказ принят — вилку не двигаем; другая дата — договоритесь с производством.</Typography.Text>}
        {production ? (
          <>
            <Space wrap>
              <span>Готовность:</span>
              <DatePicker format="DD.MM.YYYY" value={ready} onChange={setReady} />
              <span>Отгрузка:</span>
              <DatePicker format="DD.MM.YYYY" value={ship} onChange={setShip} />
            </Space>
            {moved && committed && (
              <>
                <Select placeholder="Причина переноса" style={{ width: "100%" }} options={DATE_CHANGE_REASONS} value={reason} onChange={setReason} />
                <Input.TextArea rows={2} placeholder="Комментарий" value={comment} onChange={(e) => setComment(e.target.value)} />
                <Typography.Text type="secondary">
                  Перенос попадёт в историю, менеджер его увидит; запуски этого заказа пересчитают сроки.
                </Typography.Text>
              </>
            )}
            {committed && (
              <Space wrap>
                <span>Факт готовности:</span>
                <DatePicker format="DD.MM.YYYY" value={fact} onChange={setFact} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  ставится сама по приходу всего на склад ГП
                </Typography.Text>
              </Space>
            )}
          </>
        ) : (
          <Typography.Text type="secondary">Обещанные готовность и отгрузку ставит производство.</Typography.Text>
        )}
      </Space>
    </Modal>
  );
}

/** Оценка «когда раньше всего готово»: сроки операций и очередь участков. */
export function PlanCheckView({ check, shipTo }: { check: PlanCheck; shipTo: string | null }) {
  if (check.error) return <Alert type="warning" showIcon message={check.error} />;
  return (
    <>
      <Alert
        type={check.fits === false ? "error" : check.fits ? "success" : "info"}
        showIcon
        message={
          check.earliest
            ? `Раньше всего готово к ${fmt(check.earliest)}` +
              (check.fits === true ? " — в вилку успеваем" : check.fits === false ? ` — в вилку (до ${fmt(shipTo)}) не успеваем` : "")
            : "Срок не посчитался"
        }
        description={
          check.bottleneck
            ? `Держит загрузка участка «${check.bottleneck}». По срокам операций — ${fmt(check.by_route)}.`
            : "Держат сроки операций по маршруту. У участков без мощности (не задана и нет отчётов за 4 недели) очередь не учтена."
        }
      />
      <Table
        size="small"
        rowKey="area"
        pagination={false}
        dataSource={check.areas}
        columns={[
          { title: "Участок", dataIndex: "name" },
          { title: "Этот заказ, шт", dataIndex: "order_pieces", align: "right" },
          { title: "Уже в очереди, шт", dataIndex: "queue_pieces", align: "right" },
          {
            title: "Мощность в день",
            dataIndex: "per_day",
            align: "right",
            render: (v, a) =>
              v == null ? (
                <Typography.Text type="secondary">не задана</Typography.Text>
              ) : (
                <span title={a.per_day_source === "fact" ? "по отчётам за 4 недели — задать вручную: Настройки → Участки" : "задана у участка"}>
                  {v}
                  {a.per_day_source === "fact" && <Typography.Text type="secondary"> по факту</Typography.Text>}
                </span>
              ),
          },
          { title: "Дней", dataIndex: "days", align: "right", render: (v) => v ?? "—" },
        ]}
      />
    </>
  );
}
