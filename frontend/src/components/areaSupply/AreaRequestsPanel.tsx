import { useState } from "react";
import { Button, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import ResponsiveTable from "../ResponsiveTable";
import { useAuth } from "../../auth/AuthContext";
import { hasPerm } from "../../auth/permissions";
import { listAreas } from "../../api/areas";
import {
  acceptAreaRequest,
  cancelAreaRequest,
  createAreaRequest,
  doneAreaRequest,
  listAreaRequests,
  searchSupplyCatalog,
  type AreaRequest,
  type AreaRequestIn,
  type RequestStatus,
  type SupplyKind,
} from "../../api/areaSupply";
import { apiErrorMessage } from "../../utils/apiError";

export const KIND_LABEL: Record<SupplyKind, string> = { plenka: "плёнка", pf: "п/ф", material: "материал" };
const STATUS: Record<RequestStatus, { label: string; color: string }> = {
  new: { label: "новая", color: "red" },
  accepted: { label: "в работе", color: "orange" },
  done: { label: "выдано", color: "green" },
  cancelled: { label: "отменена", color: "default" },
};
const num = (v: number | null) => (v == null ? "" : Math.round(v * 100) / 100);

/** Участок, которым ограничен пользователь (как на сервере): с участком в
 * профиле и без права «Задания всех участков» — только свой. */
export function useOwnArea(): string | null {
  const { user } = useAuth();
  if (!user || hasPerm(user, "production_tasks.all_areas") || !user.area) return null;
  return user.area;
}

/** Подбор позиции номенклатуры для заявки/нормы: плёнка — группой, п/ф, материалы. */
export function SupplyItemSelect({
  kind,
  value,
  onChange,
  measurableOnly,
  fallbackLabel,
}: {
  kind?: SupplyKind;
  value?: number;
  onChange?: (v: number | undefined, unit?: string, k?: SupplyKind) => void;
  measurableOnly?: boolean;
  /** подпись выбранной позиции, если её нет в текущей выдаче поиска */
  fallbackLabel?: string;
}) {
  const [q, setQ] = useState("");
  const res = useQuery({ queryKey: ["supply-catalog", kind, q], queryFn: () => searchSupplyCatalog({ kind, q }), staleTime: 60000 });
  const opts = (res.data ?? []).filter((i) => !measurableOnly || i.measurable);
  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      onSearch={setQ}
      value={value}
      loading={res.isFetching}
      placeholder="Начните вводить: цвет плёнки, деталь, материал"
      onChange={(v) => {
        const it = opts.find((o) => o.item_id === v);
        onChange?.(v, it?.unit, it?.kind);
      }}
      options={[
        ...(value != null && fallbackLabel && !opts.some((o) => o.item_id === value) ? [{ value, label: fallbackLabel }] : []),
        ...opts.map((i) => ({ value: i.item_id, label: kind ? i.label : `${i.label} · ${KIND_LABEL[i.kind]}` })),
      ]}
    />
  );
}

export function NewRequestModal({
  open,
  onClose,
  kind,
  initial,
  initialLabel,
  initialUnit,
}: {
  open: boolean;
  onClose: () => void;
  kind?: SupplyKind;
  initial?: Partial<AreaRequestIn>;
  initialLabel?: string;
  initialUnit?: string;
}) {
  const qc = useQueryClient();
  const own = useOwnArea();
  const areas = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const [form] = Form.useForm();
  const [unit, setUnit] = useState<string | undefined>(initialUnit);
  const [pickedKind, setPickedKind] = useState<SupplyKind | undefined>(kind);
  const save = useMutation({
    mutationFn: (v: AreaRequestIn) => createAreaRequest(v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["area-requests"] });
      qc.invalidateQueries({ queryKey: ["area-requests-summary"] });
      qc.invalidateQueries({ queryKey: ["area-norms"] });
      message.success("Заявка подана — склад её увидит");
      form.resetFields();
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось подать заявку")),
  });
  return (
    <Modal
      open={open}
      title="Заявка участка"
      okText="Подать"
      onCancel={onClose}
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ area: own ?? undefined, ...initial }}
        onFinish={(v) =>
          save.mutate({
            area: v.area,
            item_id: v.item_id ?? null,
            what: v.what ?? null,
            qty: v.qty ?? null,
            width_mm: v.width_mm ?? null,
            needed_by: v.needed_by ? dayjs(v.needed_by).format("YYYY-MM-DD") : null,
            note: v.note ?? null,
          })
        }
      >
        <Form.Item name="area" label="Участок" rules={[{ required: true, message: "Выберите участок" }]}>
          <Select
            disabled={!!own}
            showSearch
            optionFilterProp="label"
            options={(areas.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
          />
        </Form.Item>
        <Form.Item name="item_id" label="Что нужно">
          <SupplyItemSelect
            kind={kind}
            fallbackLabel={initialLabel}
            onChange={(v, u, k) => {
              form.setFieldValue("item_id", v);
              setUnit(u);
              setPickedKind(k ?? kind);
            }}
          />
        </Form.Item>
        <Form.Item name="what" label="…или своими словами" extra="Если позиции нет в списке">
          <Input maxLength={255} />
        </Form.Item>
        <Space wrap>
          <Form.Item name="qty" label={`Сколько${unit ? `, ${unit}` : ""}`}>
            <InputNumber min={0} style={{ width: 140 }} />
          </Form.Item>
          {(pickedKind ?? "plenka") === "plenka" && (
            <Form.Item name="width_mm" label="Ширина, мм">
              <InputNumber min={1} style={{ width: 120 }} />
            </Form.Item>
          )}
          <Form.Item name="needed_by" label="Нужно к">
            <DatePicker format="DD.MM.YYYY" />
          </Form.Item>
        </Space>
        <Form.Item name="note" label="Комментарий">
          <Input maxLength={255} placeholder="например: рулон закончился, пресс стоит" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Заявки участков (15.10): «нужен рулон», «закончился клей» — подаёт
 * участок, склад берёт в работу и отмечает «выдано». */
export default function AreaRequestsPanel({ kind }: { kind?: SupplyKind }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canCreate = hasPerm(user, "production_tasks.report", "production_tasks.manage", "units.issue");
  const canHandle = hasPerm(user, "units.issue", "production_tasks.manage");
  const [mode, setMode] = useState<"open" | "all">("open");
  const [adding, setAdding] = useState(false);
  const q = useQuery({
    queryKey: ["area-requests", kind ?? "all", mode],
    queryFn: () => listAreaRequests({ kind, open_only: mode === "open" }),
    refetchInterval: 60000,
  });
  const act = useMutation({
    mutationFn: async ({ id, op, note }: { id: number; op: "accept" | "done" | "cancel"; note?: string }) =>
      op === "accept" ? acceptAreaRequest(id) : op === "done" ? doneAreaRequest(id, note) : cancelAreaRequest(id, note),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: ["area-requests"] });
      qc.invalidateQueries({ queryKey: ["area-requests-summary"] });
      qc.invalidateQueries({ queryKey: ["area-norms"] });
      message.success(v.op === "accept" ? "Взято в работу" : v.op === "done" ? "Отмечено «выдано»" : "Заявка отменена");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не получилось")),
  });
  const today = dayjs().format("YYYY-MM-DD");
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Space wrap>
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as "open" | "all")}
          options={[
            { value: "open", label: "Открытые" },
            { value: "all", label: "Все за 30 дней" },
          ]}
        />
        {canCreate && (
          <Button type="primary" onClick={() => setAdding(true)}>
            Подать заявку
          </Button>
        )}
      </Space>
      <ResponsiveTable<AreaRequest>
        tableKey={`area-requests-${kind ?? "all"}`}
        exportTitle="Заявки участков"
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={q.data ?? []}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: mode === "open" ? "Открытых заявок нет" : "Заявок нет" }}
        columns={[
          {
            title: "Нужно к",
            dataIndex: "needed_by",
            render: (v: string | null, r) =>
              v ? (
                <Typography.Text type={v < today && (r.status === "new" || r.status === "accepted") ? "danger" : undefined}>
                  {dayjs(v).format("DD.MM")}
                </Typography.Text>
              ) : (
                "—"
              ),
          },
          { title: "Участок", dataIndex: "area_name" },
          {
            title: "Что",
            render: (_, r) => (
              <Space size={4} wrap>
                {!kind && r.kind && <Tag>{KIND_LABEL[r.kind]}</Tag>}
                <span>{r.label}</span>
              </Space>
            ),
          },
          {
            title: "Сколько",
            align: "right",
            render: (_, r) =>
              [r.qty != null ? `${num(r.qty)} ${r.unit ?? ""}` : null, r.width_mm ? `ширина ${r.width_mm} мм` : null].filter(Boolean).join(", ") || "—",
          },
          {
            title: "Выдано",
            align: "right",
            render: (_, r) => (r.issued_qty > 0 ? `${num(r.issued_qty)} ${r.unit ?? ""}` : "—"),
          },
          {
            title: "На участке сейчас",
            align: "right",
            render: (_, r) => (r.area_stock == null ? "—" : `${num(r.area_stock)} ${r.kind === "plenka" ? "м²" : "шт"}`),
          },
          ...(kind === "plenka" || kind === undefined
            ? [
                {
                  title: "На складах",
                  align: "right" as const,
                  render: (_: unknown, r: AreaRequest) =>
                    r.warehouse_stock_m2 == null ? (
                      "—"
                    ) : r.warehouse_stock_m2 <= 0 ? (
                      <Typography.Text type="danger">нет</Typography.Text>
                    ) : (
                      `${num(r.warehouse_stock_m2)} м²`
                    ),
                },
              ]
            : []),
          { title: "Комментарий", dataIndex: "note", render: (v: string | null) => v ?? "" },
          {
            title: "Подал",
            render: (_, r) => `${r.created_by_name ?? ""} ${dayjs(r.created_at).format("DD.MM HH:mm")}`,
          },
          {
            title: "Статус",
            render: (_, r) => (
              <Space direction="vertical" size={0}>
                <Tag color={STATUS[r.status].color}>{STATUS[r.status].label}</Tag>
                {r.closed_at && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.closed_by_name} {dayjs(r.closed_at).format("DD.MM HH:mm")}
                    {r.close_note ? ` — ${r.close_note}` : ""}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: "",
            render: (_, r) =>
              r.status === "new" || r.status === "accepted" ? (
                <Space size={4}>
                  {canHandle && r.status === "new" && (
                    <Button size="small" onClick={() => act.mutate({ id: r.id, op: "accept" })}>
                      В работу
                    </Button>
                  )}
                  {canHandle && (
                    <Button size="small" type="primary" onClick={() => act.mutate({ id: r.id, op: "done" })}>
                      Выдано
                    </Button>
                  )}
                  {canCreate && (
                    <Popconfirm title="Отменить заявку?" onConfirm={() => act.mutate({ id: r.id, op: "cancel" })}>
                      <Button size="small" danger type="text">
                        Отменить
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ) : null,
          },
        ]}
      />
      <NewRequestModal open={adding} onClose={() => setAdding(false)} kind={kind} />
    </Space>
  );
}
