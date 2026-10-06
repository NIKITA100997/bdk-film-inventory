import { useMemo, useState } from "react";
import { Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { listSites } from "../../api/sites";
import {
  FG_KIND_LABEL,
  adjustFg,
  listFgInvoices,
  listFgMoves,
  listFgStock,
  type FgStockRow,
} from "../../api/finishedGoods";
import { apiErrorMessage } from "../../utils/apiError";

const n = (v: number) => `${Math.round(v * 100) / 100}`;

/** «Остатки → Изделия» (06.10): готовые двери на складе площадки — по
 * позиции, счёту и заказу. Приход — сам, из отчёта упаковки. */
export function FgStockTab() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canShip = !!user?.is_superuser || !!user?.permissions.includes("fg.ship");
  const [q, setQ] = useState("");
  const [adjust, setAdjust] = useState<FgStockRow | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const stockQuery = useQuery({ queryKey: ["fg-stock"], queryFn: listFgStock });
  const rows = useMemo(() => {
    const f = q.trim().toLowerCase();
    return (stockQuery.data ?? []).filter(
      (r) => !f || r.item_name.toLowerCase().includes(f) || (r.invoice_no ?? "").toLowerCase().includes(f) || (r.order_name ?? "").toLowerCase().includes(f),
    );
  }, [stockQuery.data, q]);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
        <Space wrap>
          <Input.Search allowClear placeholder="Изделие, счёт или заказ" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Typography.Text type="secondary">
            На складе: {n(total)} шт · позиций {rows.length}
          </Typography.Text>
        </Space>
        <Space wrap>
          <Button onClick={() => navigate("/shipments")}>Отгрузка по счёту →</Button>
          {canShip && <Button onClick={() => setReceiveOpen(true)}>Оприходовать упакованное раньше</Button>}
        </Space>
      </Space>
      <Table<FgStockRow>
        size="small"
        rowKey={(r) => `${r.item_id}-${r.site_id}-${r.order_line_id}`}
        loading={stockQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Готовой продукции на складе нет — она появится после отчёта об упаковке" }}
        columns={[
          { title: "Изделие", render: (_, r) => <a onClick={() => navigate(`/item/${r.item_id}`)}>{r.item_name}</a> },
          { title: "Счёт 1С", render: (_, r) => (r.invoice_no ? <Tag>{r.invoice_no}</Tag> : <Typography.Text type="secondary">на склад</Typography.Text>) },
          { title: "Заказ", render: (_, r) => (r.order_id ? <a onClick={() => navigate(`/production-orders/${r.order_id}`)}>№{r.order_id} «{r.order_name}»</a> : "—") },
          { title: "Площадка", render: (_, r) => r.site_name ?? "—" },
          { title: "На складе, шт", align: "right", render: (_, r) => <b>{n(r.qty)}</b> },
          ...(canShip
            ? [{ title: "", render: (_: unknown, r: FgStockRow) => <Button size="small" onClick={() => setAdjust(r)}>Скорректировать</Button> }]
            : []),
        ]}
      />
      {adjust && <AdjustModal row={adjust} onClose={() => setAdjust(null)} />}
      {receiveOpen && <ReceiveModal stock={stockQuery.data ?? []} onClose={() => setReceiveOpen(false)} />}
    </Space>
  );
}

function AdjustModal({ row, onClose }: { row: FgStockRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ actual_qty: number; reason: string }>();
  const m = useMutation({
    mutationFn: (v: { actual_qty: number; reason: string }) =>
      adjustFg({ item_id: row.item_id, site_id: row.site_id, order_line_id: row.order_line_id, actual_qty: v.actual_qty, reason: v.reason.trim() }),
    onSuccess: () => {
      for (const k of ["fg-stock", "fg-moves", "fg-invoices"]) qc.invalidateQueries({ queryKey: [k] });
      message.success("Скорректировано");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось скорректировать")),
  });
  return (
    <Modal open title={`Скорректировать — ${row.item_name}`} okText="Скорректировать" cancelText="Отмена" onCancel={onClose} onOk={() => form.submit()} okButtonProps={{ loading: m.isPending }} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        {row.invoice_no ? `Счёт ${row.invoice_no}` : "На склад"} · {row.site_name ?? "площадка не указана"} · по учёту {n(row.qty)} шт. Разница запишется корректировкой.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ actual_qty: row.qty }} onFinish={(v) => m.mutate(v)}>
        <Form.Item name="actual_qty" label="Фактически на складе, шт" rules={[{ required: true }]}>
          <InputNumber min={0} precision={0} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="reason" label="Причина" rules={[{ required: true, whitespace: true, message: "Укажите причину" }]}>
          <Input placeholder="например, пересчитали склад" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Двери, упакованные до запуска склада, — оприходовать под строку счёта. */
function ReceiveModal({ stock, onClose }: { stock: FgStockRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ order_line_id: number; site_id?: number; qty: number }>();
  const invQuery = useQuery({ queryKey: ["fg-invoices"], queryFn: listFgInvoices });
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: listSites });
  const lines = (invQuery.data ?? []).flatMap((i) => i.lines.map((l) => ({ ...l, invoice_no: i.invoice_no })));
  const m = useMutation({
    mutationFn: async (v: { order_line_id: number; site_id?: number; qty: number }) => {
      const ln = lines.find((l) => l.order_line_id === v.order_line_id)!;
      const site = v.site_id ?? null;
      const cur = stock.find((s) => s.order_line_id === v.order_line_id && s.site_id === site)?.qty ?? 0;
      return adjustFg({ item_id: ln.item_id, site_id: site, order_line_id: v.order_line_id, actual_qty: cur + v.qty, reason: "Упаковано до запуска склада готовой продукции" });
    },
    onSuccess: () => {
      for (const k of ["fg-stock", "fg-moves", "fg-invoices"]) qc.invalidateQueries({ queryKey: [k] });
      message.success("Оприходовано");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось оприходовать")),
  });
  return (
    <Modal open title="Оприходовать упакованное раньше" okText="Оприходовать" cancelText="Отмена" onCancel={onClose} onOk={() => form.submit()} okButtonProps={{ loading: m.isPending }} destroyOnHidden width={620}>
      <Typography.Paragraph type="secondary">
        Двери, упакованные до запуска склада, на него сами не попали. Выберите строку счёта, площадку и сколько лежит.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={(v) => m.mutate(v)}>
        <Form.Item name="order_line_id" label="Счёт и изделие" rules={[{ required: true, message: "Выберите строку" }]}>
          <Select
            showSearch
            optionFilterProp="label"
            loading={invQuery.isLoading}
            placeholder="Номер счёта или изделие"
            options={lines.map((l) => ({
              value: l.order_line_id,
              label: `${l.invoice_no} · ${l.item_name} · заказано ${n(l.ordered)}, на складе ${n(l.on_stock)}`,
            }))}
          />
        </Form.Item>
        <Form.Item name="site_id" label="Площадка">
          <Select allowClear placeholder="Не указана" options={(sitesQuery.data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        </Form.Item>
        <Form.Item name="qty" label="Сколько штук" rules={[{ required: true, message: "Количество" }]}>
          <InputNumber min={1} precision={0} style={{ width: "100%" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function FgMovesTab() {
  const q = useQuery({ queryKey: ["fg-moves"], queryFn: listFgMoves });
  return (
    <Table
      size="small"
      rowKey="id"
      loading={q.isLoading}
      dataSource={q.data ?? []}
      pagination={{ pageSize: 50 }}
      scroll={{ x: "max-content" }}
      locale={{ emptyText: "Движений нет" }}
      columns={[
        { title: "Когда", render: (_, m) => dayjs(m.occurred_at).format("DD.MM.YYYY HH:mm") },
        { title: "Событие", render: (_, m) => <Tag color={m.kind === "receipt" ? "green" : m.kind === "shipment" ? "blue" : "default"}>{FG_KIND_LABEL[m.kind]}</Tag> },
        { title: "Изделие", dataIndex: "item_name" },
        {
          title: "Кол-во",
          align: "right",
          render: (_, m) => <Typography.Text type={m.qty < 0 ? "danger" : "success"}>{m.qty > 0 ? "+" : ""}{n(m.qty)}</Typography.Text>,
        },
        { title: "Счёт", render: (_, m) => m.invoice_no ?? "—" },
        { title: "Площадка", render: (_, m) => m.site_name ?? "—" },
        { title: "Отгрузка", render: (_, m) => (m.shipment_id ? `№${m.shipment_id}` : "—") },
        { title: "Кто", render: (_, m) => m.user_name ?? "" },
        { title: "Заметка", render: (_, m) => m.note ?? "" },
      ]}
    />
  );
}
