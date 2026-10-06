import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { PrinterOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import { listSites } from "../../api/sites";
import { cancelFgShipment, listFgInvoices, listFgShipments, shipFg, type FgInvoice, type FgShipment } from "../../api/finishedGoods";
import { printReport } from "../../utils/printReport";
import { apiErrorMessage } from "../../utils/apiError";
import { useTabTitle } from "../../layout/tabTitle";

const n = (v: number) => `${Math.round(v * 100) / 100}`;

/** Отгрузка по счёту (06.10): готовые двери со склада площадки — частично или
 * целиком; лист отгрузки на печать; отгрузку можно отменить — двери
 * вернутся на склад. Отгрузочные документы — в 1С. */
export default function Shipments() {
  useTabTitle("Отгрузка");
  return (
    <Card>
      <Typography.Title level={4}>Отгрузка готовой продукции</Typography.Title>
      <Tabs
        items={[
          { key: "ship", label: "По счетам", children: <ShipByInvoice /> },
          { key: "history", label: "История отгрузок", children: <History /> },
        ]}
        destroyOnHidden
      />
    </Card>
  );
}

function printSheet(sh: FgShipment) {
  printReport(
    `Лист отгрузки №${sh.id} · счёт ${sh.invoice_no ?? "—"}${sh.customer ? ` · ${sh.customer}` : ""} · ${dayjs(sh.created_at).format("DD.MM.YYYY HH:mm")}`,
    [
      { key: "item", header: "Изделие" },
      { key: "qty", header: "Кол-во, шт" },
      { key: "order", header: "Заказ" },
      { key: "site", header: "Площадка" },
      { key: "check", header: "Отметка" },
    ],
    [
      ...sh.lines.map((l) => ({ item: l.item_name, qty: n(l.qty), order: l.order_name ?? "", site: l.site_name ?? "", check: "" })),
      { item: "Итого", qty: n(sh.total), order: "", site: "", check: "" },
      { item: "Отгрузил: ____________   Принял: ____________", qty: "", order: "", site: "", check: "" },
    ],
  );
}

function ShipByInvoice() {
  const { user } = useAuth();
  const canShip = !!user?.is_superuser || !!user?.permissions.includes("fg.ship");
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const invQuery = useQuery({ queryKey: ["fg-invoices"], queryFn: listFgInvoices });
  const invoices = useMemo(() => {
    const f = q.trim().toLowerCase();
    return (invQuery.data ?? []).filter(
      (i) => !f || i.invoice_no.toLowerCase().includes(f) || i.orders.some((o) => o.toLowerCase().includes(f)) || i.lines.some((l) => l.item_name.toLowerCase().includes(f)),
    );
  }, [invQuery.data, q]);
  const current = invoices.find((i) => i.invoice_no === sel) ?? null;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Input.Search allowClear placeholder="Номер счёта, заказ или изделие" style={{ maxWidth: 360 }} value={q} onChange={(e) => setQ(e.target.value)} />
      <Table<FgInvoice>
        size="small"
        rowKey="invoice_no"
        loading={invQuery.isLoading}
        dataSource={invoices}
        pagination={{ pageSize: 15 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Счетов нет — счёт 1С берётся из строк заказов" }}
        onRow={(i) => ({ onClick: () => setSel(i.invoice_no), style: { cursor: "pointer", background: i.invoice_no === sel ? "rgba(201,122,43,.08)" : undefined } })}
        columns={[
          { title: "Счёт 1С", render: (_, i) => <b>{i.invoice_no}</b> },
          { title: "Заказы", render: (_, i) => i.orders.join(", ") },
          { title: "Заказано", align: "right", render: (_, i) => n(i.ordered) },
          { title: "Упаковано", align: "right", render: (_, i) => n(i.received) },
          { title: "Отгружено", align: "right", render: (_, i) => n(i.shipped) },
          {
            title: "К отгрузке",
            render: (_, i) =>
              i.on_stock > 0 ? (
                <Tag color="green">на складе {n(i.on_stock)}</Tag>
              ) : i.shipped >= i.ordered && i.ordered > 0 ? (
                <Tag>отгружен</Tag>
              ) : (
                <Typography.Text type="secondary">ещё не упаковано</Typography.Text>
              ),
          },
          { title: "", render: (_, i) => <Progress percent={i.ordered ? Math.round((i.shipped / i.ordered) * 100) : 0} size="small" style={{ width: 110 }} /> },
        ]}
      />
      {current && <InvoicePanel key={`${current.invoice_no}-${current.on_stock}-${current.shipped}`} inv={current} canShip={canShip} onShipped={() => qc.invalidateQueries({ queryKey: ["fg-invoices"] })} />}
    </Space>
  );
}

function InvoicePanel({ inv, canShip, onShipped }: { inv: FgInvoice; canShip: boolean; onShipped: () => void }) {
  const qc = useQueryClient();
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: listSites });
  const siteName = (id: string) => (id === "0" ? "площадка не указана" : (sitesQuery.data ?? []).find((s) => String(s.id) === id)?.name ?? `#${id}`);
  // строки отгрузки: строка заказа × площадка, где есть на складе
  const rows = inv.lines.flatMap((l) =>
    Object.entries(l.by_site)
      .filter(([, qty]) => qty > 0)
      .map(([site, qty]) => ({ key: `${l.order_line_id}-${site}`, line: l, site, stock: qty })),
  );
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(rows.map((r) => [r.key, r.stock])));
  const [customer, setCustomer] = useState("");
  const [note, setNote] = useState("");
  const total = rows.reduce((s, r) => s + (qty[r.key] ?? 0), 0);
  const ship = useMutation({
    mutationFn: () =>
      shipFg({
        invoice_no: inv.invoice_no,
        customer: customer.trim() || null,
        note: note.trim() || null,
        lines: rows
          .filter((r) => (qty[r.key] ?? 0) > 0)
          .map((r) => ({ order_line_id: r.line.order_line_id, site_id: r.site === "0" ? null : Number(r.site), qty: qty[r.key] })),
      }),
    onSuccess: (sh) => {
      message.success(`Отгрузка №${sh.id}: ${n(sh.total)} шт по счёту ${sh.invoice_no}`);
      for (const k of ["fg-invoices", "fg-stock", "fg-moves", "fg-shipments"]) qc.invalidateQueries({ queryKey: [k] });
      onShipped();
      printSheet(sh);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отгрузить")),
  });
  return (
    <Card size="small" title={`Счёт ${inv.invoice_no}`} extra={<Typography.Text type="secondary">{inv.orders.join(", ")}</Typography.Text>}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Table
          size="small"
          rowKey="order_line_id"
          pagination={false}
          dataSource={inv.lines}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Изделие", dataIndex: "item_name" },
            { title: "Заказ", render: (_, l) => l.order_name },
            { title: "Заказано", align: "right", render: (_, l) => n(l.ordered) },
            { title: "Упаковано", align: "right", render: (_, l) => n(l.received) },
            { title: "Отгружено", align: "right", render: (_, l) => n(l.shipped) },
            { title: "На складе", align: "right", render: (_, l) => <b>{n(l.on_stock)}</b> },
          ]}
        />
        {rows.length === 0 ? (
          <Empty description="Отгружать нечего — на складе по этому счёту ничего нет" />
        ) : !canShip ? (
          <Alert type="info" showIcon message="Отгружать может пользователь с правом «Готовая продукция: отгрузка»" />
        ) : (
          <>
            <Typography.Text strong>Отгрузить сейчас</Typography.Text>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={rows}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Изделие", render: (_, r) => r.line.item_name },
                { title: "Площадка", render: (_, r) => siteName(r.site) },
                { title: "На складе", align: "right", render: (_, r) => n(r.stock) },
                {
                  title: "Отгрузить, шт",
                  render: (_, r) => (
                    <InputNumber
                      min={0}
                      max={r.stock}
                      precision={0}
                      value={qty[r.key] ?? 0}
                      onChange={(v) => setQty((p) => ({ ...p, [r.key]: v ?? 0 }))}
                      style={{ width: 110 }}
                    />
                  ),
                },
              ]}
            />
            <Space wrap>
              <Input placeholder="Клиент / получатель (необязательно)" style={{ width: 280 }} value={customer} onChange={(e) => setCustomer(e.target.value)} />
              <Input placeholder="Заметка (машина, водитель…)" style={{ width: 280 }} value={note} onChange={(e) => setNote(e.target.value)} />
              <Button type="primary" disabled={total <= 0} loading={ship.isPending} onClick={() => ship.mutate()}>
                Отгрузить {n(total)} шт и напечатать лист
              </Button>
            </Space>
          </>
        )}
      </Space>
    </Card>
  );
}

function History() {
  const { user } = useAuth();
  const canShip = !!user?.is_superuser || !!user?.permissions.includes("fg.ship");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["fg-shipments"], queryFn: listFgShipments });
  const cancel = useMutation({
    mutationFn: (id: number) => cancelFgShipment(id),
    onSuccess: () => {
      message.success("Отгрузка отменена — двери вернулись на склад");
      for (const k of ["fg-invoices", "fg-stock", "fg-moves", "fg-shipments"]) qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отменить")),
  });
  return (
    <Table<FgShipment>
      size="small"
      rowKey="id"
      loading={q.isLoading}
      dataSource={q.data ?? []}
      pagination={{ pageSize: 30 }}
      scroll={{ x: "max-content" }}
      locale={{ emptyText: "Отгрузок ещё не было" }}
      expandable={{
        expandedRowRender: (sh) => (
          <Table
            size="small"
            rowKey={(_, i) => String(i)}
            pagination={false}
            dataSource={sh.lines}
            columns={[
              { title: "Изделие", dataIndex: "item_name" },
              { title: "Кол-во", align: "right", render: (_, l) => n(l.qty) },
              { title: "Заказ", render: (_, l) => l.order_name ?? "—" },
              { title: "Площадка", render: (_, l) => l.site_name ?? "—" },
            ]}
          />
        ),
      }}
      columns={[
        { title: "№", dataIndex: "id", width: 70 },
        { title: "Когда", render: (_, sh) => dayjs(sh.created_at).format("DD.MM.YYYY HH:mm") },
        { title: "Счёт", render: (_, sh) => sh.invoice_no ?? "—" },
        { title: "Клиент", render: (_, sh) => sh.customer ?? "" },
        { title: "Шт", align: "right", render: (_, sh) => n(sh.total) },
        { title: "Кто", render: (_, sh) => sh.created_by_name ?? "" },
        { title: "Статус", render: (_, sh) => (sh.status === "cancelled" ? <Tag color="red">отменена</Tag> : <Tag color="green">отгружено</Tag>) },
        {
          title: "",
          render: (_, sh) => (
            <Space size={4}>
              <Button size="small" icon={<PrinterOutlined />} onClick={() => printSheet(sh)}>
                Лист
              </Button>
              {canShip && sh.status !== "cancelled" && (
                <Popconfirm title="Отменить отгрузку? Двери вернутся на склад." okText="Отменить отгрузку" cancelText="Нет" onConfirm={() => cancel.mutate(sh.id)}>
                  <Button size="small" danger>
                    Отменить
                  </Button>
                </Popconfirm>
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}
