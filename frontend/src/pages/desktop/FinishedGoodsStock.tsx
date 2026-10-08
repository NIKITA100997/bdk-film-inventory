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
  transferFg,
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
  const [move, setMove] = useState<FgStockRow | null>(null);
  const stockQuery = useQuery({ queryKey: ["fg-stock"], queryFn: listFgStock });
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: listSites });
  // Основной склад готовой (Северный): с остальных площадок двери везут сюда.
  const mainSite = (sitesQuery.data ?? []).find((s) => s.is_fg_main && s.is_active) ?? null;
  const awaitingMove = mainSite ? (stockQuery.data ?? []).filter((r) => r.site_id !== mainSite.id).reduce((s, r) => s + r.qty, 0) : 0;
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
          {mainSite && awaitingMove > 0 && <Tag color="orange">ждут перевозки на {mainSite.name}: {n(awaitingMove)} шт</Tag>}
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
          {
            title: "Площадка",
            render: (_, r) => (
              <Space size={4}>
                {r.site_name ?? "—"}
                {mainSite && r.site_id !== mainSite.id && <Tag color="orange">перевалка</Tag>}
              </Space>
            ),
          },
          { title: "На складе, шт", align: "right", render: (_, r) => <b>{n(r.qty)}</b> },
          ...((stockQuery.data ?? []).some((r) => r.value_rub != null)
            ? [
                {
                  // себестоимость (08.10): по отчётам операций строки заказа
                  title: "Себестоимость",
                  align: "right" as const,
                  render: (_: unknown, r: FgStockRow) =>
                    r.value_rub != null ? (
                      <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(r.value_rub).toLocaleString("ru-RU")} ₽</span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {Math.round(r.unit_cost_rub ?? 0).toLocaleString("ru-RU")} ₽/шт
                        </Typography.Text>
                      </Space>
                    ) : (
                      "—"
                    ),
                },
              ]
            : []),
          ...(canShip
            ? [
                {
                  title: "",
                  render: (_: unknown, r: FgStockRow) => (
                    <Space size={4}>
                      <Button size="small" type={mainSite && r.site_id !== mainSite.id ? "primary" : "default"} onClick={() => setMove(r)}>
                        {mainSite && r.site_id !== mainSite.id ? `На ${mainSite.name}` : "Переместить"}
                      </Button>
                      <Button size="small" onClick={() => setAdjust(r)}>Скорректировать</Button>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
      {adjust && <AdjustModal row={adjust} onClose={() => setAdjust(null)} />}
      {move && <TransferModal row={move} defaultTo={mainSite && move.site_id !== mainSite.id ? mainSite.id : undefined} onClose={() => setMove(null)} />}
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

/** Перевезти двери на другую площадку (с Фабрики — перевалки — на Северный). */
function TransferModal({ row, defaultTo, onClose }: { row: FgStockRow; defaultTo?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: listSites });
  const [form] = Form.useForm<{ to_site_id: number; qty: number }>();
  const m = useMutation({
    mutationFn: (v: { to_site_id: number; qty: number }) =>
      transferFg({ item_id: row.item_id, order_line_id: row.order_line_id, from_site_id: row.site_id, to_site_id: v.to_site_id, qty: v.qty }),
    onSuccess: () => {
      for (const k of ["fg-stock", "fg-moves", "fg-invoices"]) qc.invalidateQueries({ queryKey: [k] });
      message.success("Перемещено");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось переместить")),
  });
  return (
    <Modal open title={`Переместить — ${row.item_name}`} okText="Переместить" cancelText="Отмена" onCancel={onClose} onOk={() => form.submit()} okButtonProps={{ loading: m.isPending }} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        {row.invoice_no ? `Счёт ${row.invoice_no}` : "На склад"} · сейчас на «{row.site_name ?? "площадка не указана"}»: {n(row.qty)} шт. Заказ и счёт остаются те же.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ to_site_id: defaultTo, qty: row.qty }} onFinish={(v) => m.mutate(v)}>
        <Form.Item name="to_site_id" label="Куда" rules={[{ required: true, message: "Выберите площадку" }]}>
          <Select
            options={(sitesQuery.data ?? [])
              .filter((s) => s.is_active && s.id !== row.site_id)
              .map((s) => ({ value: s.id, label: s.is_fg_main ? `${s.name} — основной склад` : s.name }))}
          />
        </Form.Item>
        <Form.Item name="qty" label="Сколько штук" rules={[{ required: true, message: "Количество" }]}>
          <InputNumber min={1} max={row.qty} precision={0} style={{ width: "100%" }} />
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
        { title: "Событие", render: (_, m) => <Tag color={m.kind === "receipt" ? "green" : m.kind === "shipment" ? "blue" : m.kind === "return" ? "orange" : "default"}>{FG_KIND_LABEL[m.kind]}</Tag> },
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
