import { useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate } from "react-router-dom";
import {
  AutoComplete,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import { useAuth } from "../../auth/AuthContext";
import { exportToExcel } from "../../utils/excel";
import {
  MOVE_KIND_LABEL,
  createMaterial,
  createMaterialMove,
  listMaterialStock,
  regradeMaterial,
  updateMaterial,
  type MaterialMoveKind,
  type MaterialStockRow,
} from "../../api/materialStock";
import { apiErrorMessage } from "../../utils/apiError";
import { FileExcelOutlined } from "@ant-design/icons";

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const UNITS = ["м²", "м.п.", "шт", "кг", "л", "лист", "уп"];
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

function useCanManage() {
  const { user } = useAuth();
  return (
    !!user?.is_superuser ||
    ["units.receive", "materials.manage", "production_tasks.manage", "part_units.manage"].some((p) => user?.permissions.includes(p))
  );
}

type ManualKind = Exclude<MaterialMoveKind, "consumption">;

/** Суммы видят те, у кого права на цены (08.10). */
function useCanSeePrice() {
  const { user } = useAuth();
  return !!user?.is_superuser || ["prices.view", "prices.manage"].some((p) => user?.permissions.includes(p));
}
const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

/** Остатки материалов (МДФ, пенопласт, клей, кромка…) — одним числом на
 * склад: приход, списание, инвентаризация здесь; расход в производство —
 * сам, по отчёту операции (в минус тоже — подсвечено «не оприходовано»). */
export function MaterialsStockTab() {
  const navigate = useNavigate();
  const canSeePrice = useCanSeePrice();
  const canManage = useCanManage();
  const [q, setQ] = useState("");
  const [withArchived, setWithArchived] = useState(false);
  const [onlyMinus, setOnlyMinus] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ row: MaterialStockRow; kind: ManualKind } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [regradeRow, setRegradeRow] = useState<MaterialStockRow | null>(null);
  const stockQuery = useQuery({ queryKey: ["material-stock", withArchived], queryFn: () => listMaterialStock(withArchived) });
  const rows = useMemo(
    () =>
      (stockQuery.data ?? []).filter(
        (r) => (!q.trim() || norm(r.name).includes(norm(q.trim()))) && (!onlyMinus || r.balance < 0),
      ),
    [stockQuery.data, q, onlyMinus],
  );
  const minusCount = (stockQuery.data ?? []).filter((r) => r.balance < 0).length;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="Остатки материалов"
        extra={
          <Space>
            <Button
              icon={<FileExcelOutlined />}
              disabled={rows.length === 0}
              onClick={() =>
                exportToExcel(
                  `ostatki-materialov-${dayjs().format("DD-MM-YYYY")}.xlsx`,
                  rows.map((r) => ({ name: r.name, group: r.group_name ?? "", balance: r.balance, unit: r.unit })),
                  [
                    { key: "name", header: "Материал" },
                    { key: "group", header: "Группа" },
                    { key: "balance", header: "Остаток" },
                    { key: "unit", header: "Ед." },
                  ],
                )
              }
            >
              Excel
            </Button>
            {canManage && (
              <Button type="primary" onClick={() => setNewOpen(true)}>
                + Новый материал
              </Button>
            )}
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          Остаток — одним числом на склад. Приход, списание и инвентаризация — кнопками в строке; расход в производство
          пишется сам по отчёту операции, на которой материал нужен по составу. Минус — израсходовано больше, чем
          оприходовано: проведите приход.
        </Typography.Paragraph>
        <Space wrap>
          <Input.Search allowClear placeholder="Поиск по материалу" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Checkbox checked={onlyMinus} onChange={(e) => setOnlyMinus(e.target.checked)}>
            Только в минусе{minusCount ? ` (${minusCount})` : ""}
          </Checkbox>
          <Checkbox checked={withArchived} onChange={(e) => setWithArchived(e.target.checked)}>
            С архивными
          </Checkbox>
        </Space>
      </Card>
      <ResponsiveTable<MaterialStockRow>
        tableKey="material-stock"
        lockedColumns={["Материал"]}
        size="small"
        rowKey="item_id"
        loading={stockQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Материалов нет — заведите первый кнопкой «+ Новый материал»" }}
        columns={[
          {
            title: "Материал",
            render: (_, r) => (
              <Space size={4}>
                <a onClick={() => navigate(`/item/${r.item_id}`)}>{r.name}</a>
                {!r.is_active && <Tag>архив</Tag>}
              </Space>
            ),
          },
          { title: "Группа", render: (_, r) => r.group_name ?? <Typography.Text type="secondary">—</Typography.Text> },
          {
            title: "Остаток",
            sorter: (a, b) => a.balance - b.balance,
            render: (_, r) =>
              r.balance < 0 ? (
                <Space size={4}>
                  <Typography.Text type="danger" strong style={{ fontVariantNumeric: "tabular-nums" }}>
                    {fmt(r.balance)} {r.unit}
                  </Typography.Text>
                  <Tag color="red">не оприходовано</Tag>
                </Space>
              ) : (
                <Space size={4}>
                  <Typography.Text strong style={{ fontVariantNumeric: "tabular-nums" }}>
                    {fmt(r.balance)} {r.unit}
                  </Typography.Text>
                  {/* норматив (08.10): ниже мин. остатка — пора пополнять */}
                  {r.min_stock != null && r.balance < r.min_stock && <Tag color="orange">ниже мин. {fmt(r.min_stock)}</Tag>}
                </Space>
              ),
          },
          {
            title: "Ед.",
            render: (_, r) => (canManage ? <UnitCell row={r} /> : r.unit),
          },
          ...(canSeePrice
            ? [
                {
                  // по средней цене остатка (08.10)
                  title: "Стоимость",
                  render: (_: unknown, r: MaterialStockRow) =>
                    r.value_rub != null ? (
                      <Space direction="vertical" size={0}>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>{rub(r.value_rub)}</span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          по {fmt(r.avg_price_rub ?? 0)} ₽/{r.unit}
                        </Typography.Text>
                      </Space>
                    ) : (
                      "—"
                    ),
                },
              ]
            : []),
          {
            title: "Последнее движение",
            render: (_, r) => (r.last_move_at ? dayjs(r.last_move_at).format("DD.MM.YYYY HH:mm") : "—"),
          },
          {
            title: "",
            render: (_, r) =>
              canManage && (
                <Space size={4} wrap>
                  <Button size="small" type="primary" ghost onClick={() => setMoveTarget({ row: r, kind: "receipt" })}>
                    Приход
                  </Button>
                  <Button size="small" onClick={() => setMoveTarget({ row: r, kind: "writeoff" })}>
                    Списать
                  </Button>
                  <Button size="small" onClick={() => setMoveTarget({ row: r, kind: "adjust" })}>
                    Инвентаризация
                  </Button>
                  <Button size="small" onClick={() => setRegradeRow(r)}>
                    Пересорт
                  </Button>
                </Space>
              ),
          },
        ]}
      />
      {moveTarget && <MoveModal row={moveTarget.row} kind={moveTarget.kind} onClose={() => setMoveTarget(null)} />}
      {newOpen && <NewMaterialModal onClose={() => setNewOpen(false)} />}
      {regradeRow && <RegradeModal row={regradeRow} rows={stockQuery.data ?? []} onClose={() => setRegradeRow(null)} />}
    </Space>
  );
}

function UnitCell({ row }: { row: MaterialStockRow }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (unit: string) => updateMaterial(row.item_id, { unit }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["material-stock"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сменить единицу")),
  });
  return (
    <Select
      size="small"
      style={{ width: 90 }}
      value={row.unit}
      loading={mutation.isPending}
      onChange={(u) => mutation.mutate(u)}
      options={[...new Set([row.unit, ...UNITS])].map((u) => ({ value: u, label: u }))}
    />
  );
}

function MoveModal({ row, kind, onClose }: { row: MaterialStockRow; kind: ManualKind; onClose: () => void }) {
  const qc = useQueryClient();
  type V = { qty: number; doc?: string; note?: string; occurred_at?: Dayjs; price?: number | null; price_currency?: string };
  const [form] = Form.useForm<V>();
  const mutation = useMutation({
    mutationFn: (v: V) =>
      createMaterialMove({
        item_id: row.item_id,
        kind,
        qty: v.qty,
        doc: v.doc,
        note: v.note,
        occurred_at: v.occurred_at ? v.occurred_at.format("YYYY-MM-DD") : null,
        price: kind === "receipt" ? v.price : undefined,
        price_currency: kind === "receipt" ? v.price_currency : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["material-stock"] });
      qc.invalidateQueries({ queryKey: ["material-moves"] });
      message.success(`${MOVE_KIND_LABEL[kind]}: ${row.name}`);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось провести")),
  });
  const qtyLabel = kind === "adjust" ? `Фактический остаток, ${row.unit}` : `Количество, ${row.unit}`;
  return (
    <Modal title={`${MOVE_KIND_LABEL[kind]} — ${row.name}`} open onCancel={onClose} footer={null} destroyOnHidden width={460}>
      <Typography.Paragraph type="secondary">
        Сейчас на остатке: {fmt(row.balance)} {row.unit}.
        {kind === "adjust" && " Введите, сколько есть по факту, — запишется разница."}
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
        <Form.Item name="qty" label={qtyLabel} rules={[{ required: true, message: "Укажите количество" }]}>
          <InputNumber min={0} step={0.1} style={{ width: "100%" }} autoFocus />
        </Form.Item>
        {kind === "receipt" && (
          <Form.Item name="doc" label="Документ (УПД, накладная)">
            <Input placeholder="Необязательно" />
          </Form.Item>
        )}
        {kind === "receipt" && (
          <Space.Compact style={{ width: "100%", marginBottom: 24 }}>
            <Form.Item name="price" noStyle>
              <InputNumber min={0} step={0.01} style={{ width: "70%" }} placeholder={`Цена по УПД за ${row.unit} — необязательно`} />
            </Form.Item>
            <Form.Item name="price_currency" noStyle initialValue="RUB">
              <Select
                style={{ width: "30%" }}
                options={[
                  { value: "RUB", label: "₽" },
                  { value: "EUR", label: "€" },
                  { value: "USD", label: "$" },
                ]}
              />
            </Form.Item>
          </Space.Compact>
        )}
        <Form.Item
          name="note"
          label={kind === "writeoff" ? "Причина списания" : "Заметка"}
          rules={kind === "writeoff" ? [{ required: true, message: "Укажите причину" }] : undefined}
        >
          <Input />
        </Form.Item>
        <Form.Item name="occurred_at" label="Дата" extra="Не указано — сегодня">
          <DatePicker format="DD.MM.YYYY" style={{ width: "100%" }} disabledDate={(d) => d.isAfter(dayjs(), "day")} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Провести
        </Button>
      </Form>
    </Modal>
  );
}

/** Пересорт (14.10): часть остатка числилась не той позицией — минус с этой,
 * плюс на правильную, одной операцией с причиной (как у рулона и партии п/ф). */
function RegradeModal({ row, rows, onClose }: { row: MaterialStockRow; rows: MaterialStockRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  type V = { dst: number; qty: number; reason: string };
  const mutation = useMutation({
    mutationFn: (v: V) => regradeMaterial({ src_item_id: row.item_id, dst_item_id: v.dst, qty: v.qty, reason: v.reason.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["material-stock"] });
      qc.invalidateQueries({ queryKey: ["material-moves"] });
      message.success(`Пересорт: ${row.name}`);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось провести пересорт")),
  });
  return (
    <Modal title={`Пересорт — ${row.name}`} open onCancel={onClose} footer={null} destroyOnHidden width={520}>
      <Typography.Paragraph type="secondary">
        Сейчас на остатке: {fmt(row.balance)} {row.unit}. Часть числилась этой позицией, а на самом деле — другой: столько же
        уйдёт с этой и придёт на правильную, в движениях — «Пересорт» с причиной.
      </Typography.Paragraph>
      <Form<V> layout="vertical" initialValues={{ qty: row.balance > 0 ? row.balance : undefined }} onFinish={(v) => mutation.mutate(v)}>
        <Form.Item name="dst" label="Правильная позиция" rules={[{ required: true, message: "Выберите позицию" }]}>
          <Select
            showSearch
            optionFilterProp="label"
            options={rows.filter((r) => r.item_id !== row.item_id).map((r) => ({ value: r.item_id, label: `${r.name} (${r.unit})` }))}
          />
        </Form.Item>
        <Form.Item name="qty" label={`Количество, ${row.unit}`} rules={[{ required: true, message: "Укажите количество" }]}>
          <InputNumber min={0.001} step={0.1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="reason" label="Причина" rules={[{ required: true, whitespace: true, message: "Укажите причину" }]}>
          <Input placeholder="например, при приходе выбрали не ту толщину" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Провести пересорт
        </Button>
      </Form>
    </Modal>
  );
}

function NewMaterialModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form] = Form.useForm<{ name: string; unit: string }>();
  const mutation = useMutation({
    mutationFn: (v: { name: string; unit: string }) => createMaterial(v),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["material-stock"] });
      qc.invalidateQueries({ queryKey: ["items"] });
      message.success(`Материал «${r.name}» заведён`);
      onClose();
      navigate(`/item/${r.item_id}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось завести материал")),
  });
  return (
    <Modal title="Новый материал" open onCancel={onClose} footer={null} destroyOnHidden width={460}>
      <Form form={form} layout="vertical" initialValues={{ unit: "м²" }} onFinish={(v) => mutation.mutate(v)}>
        <Form.Item name="name" label="Название" rules={[{ required: true, message: "Укажите название" }]}>
          <Input placeholder="Например, Клей ПВА D3, Кромка ABS 2 мм чёрная" autoFocus />
        </Form.Item>
        <Form.Item name="unit" label="Единица" extra="Своя у каждого материала: клей — кг, кромка — м.п., МДФ — м²">
          <AutoComplete options={UNITS.map((u) => ({ value: u }))} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Завести
        </Button>
      </Form>
    </Modal>
  );
}
