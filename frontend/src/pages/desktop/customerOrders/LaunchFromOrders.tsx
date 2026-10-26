import { useMemo, useState } from "react";
import { Alert, Input, Modal, Segmented, Space, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import type { CustomerOrder, LineOption } from "../../../api/customerOrders";
import LineOptions from "../../../components/LineOptions";

type Row = {
  key: string;
  order?: CustomerOrder;
  lineId?: number;
  name: string;
  kind: string;
  left: number;
  options?: LineOption[];
  ship?: string | null;
  children?: Row[];
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const optKey = (o?: LineOption[]) => (o ?? []).filter((x) => x.value).map((x) => `${x.name}: ${x.value}`).sort().join("; ");

/** «Собрать запуск» (27.10): из чего состоят выбранные заказы клиентов —
 * по заказам (счёт → позиции, что ещё не запущено) или сводно по позициям;
 * снять галочку со строки — она останется в заказе клиента на потом.
 * Вид — отдельными запусками удобнее (погонаж и двери идут по разным участкам). */
export default function LaunchFromOrders({
  orders,
  open,
  busy,
  onClose,
  onLaunch,
}: {
  orders: CustomerOrder[];
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onLaunch: (orderIds: number[], name: string | null, lineIds: number[]) => void;
}) {
  const tree = useMemo<Row[]>(
    () =>
      orders
        .map((o) => ({
          key: `o${o.id}`,
          order: o,
          name: `${o.invoice_no}${o.customer ? ` · ${o.customer}` : ""}`,
          kind: "",
          ship: o.ship_date,
          left: 0,
          children: o.lines
            .filter((l) => l.quantity - l.launched > 0.001)
            .map((l) => ({
              key: String(l.id), lineId: l.id, order: o, name: l.item_name, kind: l.kind_name ?? "Прочее",
              left: r2(l.quantity - l.launched), options: l.options,
            })),
        }))
        .map((r) => ({ ...r, left: r2(r.children.reduce((s, c) => s + c.left, 0)) }))
        .filter((r) => r.children.length),
    [orders],
  );
  const lines = useMemo(() => tree.flatMap((r) => r.children ?? []), [tree]);
  const kinds = useMemo(() => [...new Set(lines.map((l) => l.kind))], [lines]);
  const [sel, setSel] = useState<string[] | null>(null);
  const picked = sel ?? lines.map((l) => l.key);
  const pickedLines = lines.filter((l) => picked.includes(l.key));
  const [view, setView] = useState<"orders" | "items">("orders");
  const [name, setName] = useState("");

  const byKind = kinds.map((k) => ({ k, qty: r2(pickedLines.filter((l) => l.kind === k).reduce((s, l) => s + l.left, 0)) }));
  const summary = useMemo(() => {
    const m = new Map<string, { name: string; kind: string; opts: string; qty: number; invoices: Set<string> }>();
    for (const l of pickedLines) {
      const key = `${l.name}|${optKey(l.options)}`;
      const cur = m.get(key) ?? { name: l.name, kind: l.kind, opts: optKey(l.options), qty: 0, invoices: new Set<string>() };
      cur.qty += l.left;
      cur.invoices.add(l.order!.invoice_no);
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }, [pickedLines]);

  const pickKind = (k: string | null) => setSel(lines.filter((l) => !k || l.kind === k).map((l) => l.key));

  return (
    <Modal
      open={open}
      width={Math.min(1100, window.innerWidth - 32)}
      title="Собрать запуск из заказов клиентов"
      okText={`Собрать и открыть (${pickedLines.length} поз.)`}
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ loading: busy, disabled: !pickedLines.length }}
      onOk={() =>
        onLaunch(
          [...new Set(pickedLines.map((l) => l.order!.id))],
          name.trim() || null,
          pickedLines.map((l) => l.lineId!),
        )
      }
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space wrap>
          <Typography.Text strong>
            Выбрано: {pickedLines.length} поз., {r2(pickedLines.reduce((s, l) => s + l.left, 0))} шт
          </Typography.Text>
          {byKind.map(({ k, qty }) => (
            <Tag key={k}>
              {k}: {qty} шт
            </Tag>
          ))}
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">Взять:</Typography.Text>
          <Tag.CheckableTag checked={picked.length === lines.length} onChange={() => pickKind(null)}>
            всё
          </Tag.CheckableTag>
          {kinds.map((k) => (
            <Tag.CheckableTag
              key={k}
              checked={pickedLines.length > 0 && pickedLines.every((l) => l.kind === k) && pickedLines.length === lines.filter((l) => l.kind === k).length}
              onChange={() => pickKind(k)}
            >
              только {k.toLowerCase()}
            </Tag.CheckableTag>
          ))}
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as typeof view)}
            options={[
              { label: "По заказам", value: "orders" },
              { label: "Сводно по позициям", value: "items" },
            ]}
          />
        </Space>
        {kinds.length > 1 && (
          <Alert
            type="info"
            showIcon
            message="В заказах разные виды продукции — погонаж и двери удобнее запускать отдельно: снимите лишнее или нажмите «только …»."
          />
        )}
        {view === "orders" ? (
          <Table<Row>
            size="small"
            pagination={false}
            scroll={{ y: 420 }}
            dataSource={tree}
            expandable={{ defaultExpandAllRows: true }}
            rowSelection={{
              checkStrictly: false,
              selectedRowKeys: picked,
              onChange: (keys) => setSel((keys as string[]).filter((k) => !k.startsWith("o"))),
            }}
            columns={[
              {
                title: "Счёт / позиция",
                render: (_, r) =>
                  r.children ? (
                    <Space size={6}>
                      <b>{r.name}</b>
                      {r.ship && <Typography.Text type="secondary">отгрузка {dayjs(r.ship).format("DD.MM")}</Typography.Text>}
                    </Space>
                  ) : (
                    <Space direction="vertical" size={0}>
                      <span>{r.name}</span>
                      <LineOptions compact options={r.options} />
                    </Space>
                  ),
              },
              { title: "Вид", width: 120, render: (_, r) => (r.children ? "" : r.kind) },
              { title: "Запустить, шт", width: 120, align: "right", render: (_, r) => (r.children ? <b>{r.left}</b> : r.left) },
            ]}
          />
        ) : (
          <Table
            size="small"
            pagination={false}
            scroll={{ y: 420 }}
            rowKey={(r) => `${r.name}|${r.opts}`}
            dataSource={summary}
            columns={[
              {
                title: "Позиция",
                render: (_, r) => (
                  <Space direction="vertical" size={0}>
                    <span>{r.name}</span>
                    {r.opts && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.opts}</Typography.Text>}
                  </Space>
                ),
              },
              { title: "Вид", width: 120, dataIndex: "kind" },
              { title: "Шт", width: 80, align: "right", render: (_, r) => <b>{r2(r.qty)}</b> },
              { title: "Счета", width: 220, render: (_, r) => [...r.invoices].join(", ") },
            ]}
          />
        )}
        <Input placeholder={`Название (по умолчанию — «Запуск ${dayjs().format("DD.MM")}: счета…»)`} value={name} onChange={(e) => setName(e.target.value)} />
        <Typography.Text type="secondary">
          Получится черновик заказа на производство: там видно состав каждой позиции («из чего состоит»), выбираются п/ф со склада,
          площадки ламинации, исполнение и сроки, затем «Запустить». Не отмеченные строки остаются в заказах клиентов.
        </Typography.Text>
      </Space>
    </Modal>
  );
}
