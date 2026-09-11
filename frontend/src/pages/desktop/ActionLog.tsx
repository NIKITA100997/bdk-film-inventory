import { useState } from "react";
import { Card, Tabs, DatePicker, Select, InputNumber, Input, Space, Tag, Button, Modal, Form, message } from "antd";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import ReportTable, { type ReportColumn } from "../../components/ReportTable";
import {
  getActionLogMaterial,
  getActionLogPartUnits,
  adjustMaterialUnit,
  adjustPartUnitEntry,
  type ActionLogMaterialLine,
  type ActionLogPartUnitLine,
} from "../../api/actionLog";
import { listAreas } from "../../api/areas";
import { useAuth } from "../../auth/AuthContext";

// Раздел про журнал действий (ревизия путей плёнки/п/ф) — значения
// event_type/PartEventType как они приходят с бэкенда (enum.value,
// кириллица) — читаемая подпись просто убирает подчёркивания.
const MATERIAL_EVENT_TYPES = [
  "Приход", "Продольная_резка", "Раскрой", "Выдача_участку", "Возврат", "Списание",
  "Привязка_к_заказу", "Снятие_привязки", "Инвентаризация_подтверждено",
  "Инвентаризация_перемещено", "Инвентаризация_излишек", "Инвентаризация_недостача",
  "Инвентаризация_недостача_оставлено", "Донор_предложен", "Перемещение_начато",
  "Перемещение_принято", "Корректировка",
];
const PART_EVENT_TYPES = [
  "Производство", "Размещение", "Выдача_участку", "Переход_этапа", "Списание",
  "Завершение", "Возврат", "Корректировка",
];
const eventTypeLabel = (v: string) => v.replaceAll("_", " ");
const eventTypeOptions = (values: string[]) => values.map((v) => ({ value: v, label: eventTypeLabel(v) }));

// Раздел про формальную «Корректировку» — общая модалка для обеих
// вкладок (плёнка/п/ф), различается только заголовком поля количества
// и вызываемым мутатором.
function AdjustModal({
  open,
  title,
  currentValue,
  unitLabel,
  onCancel,
  onSubmit,
  loading,
}: {
  open: boolean;
  title: string;
  currentValue: number | undefined;
  unitLabel: string;
  onCancel: () => void;
  onSubmit: (v: { actual_value: number; reason: string; note?: string }) => void;
  loading: boolean;
}) {
  const [form] = Form.useForm<{ actual_value: number; reason: string; note?: string }>();
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okButtonProps={{ loading }}
      okText="Скорректировать"
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={onSubmit} initialValues={{ actual_value: currentValue }}>
        <Form.Item name="actual_value" label={`Фактическое значение, ${unitLabel}`} rules={[{ required: true }]}>
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="reason" label="Причина" rules={[{ required: true, message: "Укажите причину корректировки" }]}>
          <Input placeholder="Например: опечатка при вводе" />
        </Form.Item>
        <Form.Item name="note" label="Заметка (опционально)">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function MaterialLogTab({ canCorrect }: { canCorrect: boolean }) {
  const qc = useQueryClient();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, "day"), dayjs()]);
  const [eventType, setEventType] = useState<string[]>([]);
  const [area, setArea] = useState<string[]>([]);
  const [unitId, setUnitId] = useState<number | undefined>(undefined);
  const [q, setQ] = useState("");
  const [adjustTarget, setAdjustTarget] = useState<ActionLogMaterialLine | null>(null);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? areasQuery.data?.find((a) => a.code === code)?.name ?? code : "—");

  const query = useQuery({
    queryKey: ["action-log-material", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), eventType, area, unitId, q],
    queryFn: () =>
      getActionLogMaterial({
        date_from: range[0].format("YYYY-MM-DD"),
        date_to: range[1].format("YYYY-MM-DD"),
        event_type: eventType.length ? eventType : undefined,
        area: area.length ? area : undefined,
        unit_id: unitId,
        q: q.trim() || undefined,
      }),
  });

  const adjustMutation = useMutation({
    mutationFn: (v: { actual_value: number; reason: string; note?: string }) =>
      adjustMaterialUnit(adjustTarget!.unit_id, { actual_length_m: v.actual_value, reason: v.reason, note: v.note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action-log-material"] });
      message.success("Скорректировано");
      setAdjustTarget(null);
    },
    onError: () => message.error("Не удалось скорректировать"),
  });

  const rows = query.data ?? [];
  const columns: ReportColumn<ActionLogMaterialLine>[] = [
    {
      key: "timestamp",
      header: "Когда",
      render: (r) => new Date(r.timestamp).toLocaleString("ru-RU"),
      printValue: (r) => new Date(r.timestamp).toLocaleString("ru-RU"),
      sorter: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      defaultSortOrder: "descend",
    },
    { key: "user_name", header: "Кто", render: (r) => r.user_name, printValue: (r) => r.user_name },
    { key: "event_type", header: "Тип", render: (r) => <Tag>{eventTypeLabel(r.event_type)}</Tag>, printValue: (r) => r.event_type },
    { key: "area", header: "Участок", render: (r) => areaLabel(r.area), printValue: (r) => areaLabel(r.area) },
    { key: "unit_id", header: "Единица", render: (r) => `№${r.unit_id}`, printValue: (r) => r.unit_id },
    { key: "material", header: "Плёнка", render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`, printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
    {
      key: "change",
      header: "Было → стало",
      render: (r) =>
        r.from_length != null || r.to_length != null ? `${r.from_length ?? "—"} → ${r.to_length ?? "—"} м` : `${r.quantity_delta_m > 0 ? "+" : ""}${r.quantity_delta_m} м`,
      printValue: (r) => (r.from_length != null || r.to_length != null ? `${r.from_length ?? ""} -> ${r.to_length ?? ""}` : r.quantity_delta_m),
    },
    { key: "task", header: "Задание", render: (r) => r.task_name ?? r.part_name ?? "—", printValue: (r) => r.task_name ?? r.part_name ?? "" },
    {
      key: "note",
      header: "Причина / заметка",
      render: (r) => (r.write_off_reason_name ? `${r.write_off_reason_name}${r.write_off_note ? ` — ${r.write_off_note}` : ""}` : r.write_off_note ?? "—"),
      printValue: (r) => r.write_off_note ?? "",
    },
    ...(canCorrect
      ? [
          {
            key: "actions",
            header: "",
            render: (r: ActionLogMaterialLine) => (
              <Button size="small" onClick={() => setAdjustTarget(r)}>
                Скорректировать
              </Button>
            ),
            printValue: () => "",
          },
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
        <Select
          mode="multiple"
          allowClear
          style={{ minWidth: 220 }}
          placeholder="Тип события"
          value={eventType}
          onChange={setEventType}
          options={eventTypeOptions(MATERIAL_EVENT_TYPES)}
        />
        <Select
          mode="multiple"
          allowClear
          style={{ minWidth: 200 }}
          placeholder="Участок"
          value={area}
          onChange={setArea}
          options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
        />
        <InputNumber placeholder="№ единицы" value={unitId} onChange={(v) => setUnitId(v ?? undefined)} style={{ width: 130 }} />
        <Input placeholder="Поиск по заметке" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
      </Space>
      <ReportTable
        title="Журнал действий — плёнка"
        filename="zhurnal-deystviy-plenka.csv"
        rowKey="event_id"
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
      <AdjustModal
        open={!!adjustTarget}
        title={`Скорректировать рулон №${adjustTarget?.unit_id ?? ""}`}
        currentValue={adjustTarget?.to_length ?? undefined}
        unitLabel="м"
        loading={adjustMutation.isPending}
        onCancel={() => setAdjustTarget(null)}
        onSubmit={(v) => adjustMutation.mutate(v)}
      />
    </Space>
  );
}

function PartUnitLogTab({ canCorrect }: { canCorrect: boolean }) {
  const qc = useQueryClient();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, "day"), dayjs()]);
  const [eventType, setEventType] = useState<string[]>([]);
  const [area, setArea] = useState<string[]>([]);
  const [partUnitId, setPartUnitId] = useState<number | undefined>(undefined);
  const [q, setQ] = useState("");
  const [adjustTarget, setAdjustTarget] = useState<ActionLogPartUnitLine | null>(null);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? areasQuery.data?.find((a) => a.code === code)?.name ?? code : "—");

  const query = useQuery({
    queryKey: ["action-log-part-units", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), eventType, area, partUnitId, q],
    queryFn: () =>
      getActionLogPartUnits({
        date_from: range[0].format("YYYY-MM-DD"),
        date_to: range[1].format("YYYY-MM-DD"),
        event_type: eventType.length ? eventType : undefined,
        area: area.length ? area : undefined,
        part_unit_id: partUnitId,
        q: q.trim() || undefined,
      }),
  });

  const adjustMutation = useMutation({
    mutationFn: (v: { actual_value: number; reason: string; note?: string }) =>
      adjustPartUnitEntry(adjustTarget!.part_unit_id, { actual_quantity_pieces: v.actual_value, reason: v.reason, note: v.note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action-log-part-units"] });
      message.success("Скорректировано");
      setAdjustTarget(null);
    },
    onError: () => message.error("Не удалось скорректировать"),
  });

  const rows = query.data ?? [];
  const columns: ReportColumn<ActionLogPartUnitLine>[] = [
    {
      key: "occurred_at",
      header: "Когда",
      render: (r) => new Date(r.occurred_at).toLocaleString("ru-RU"),
      printValue: (r) => new Date(r.occurred_at).toLocaleString("ru-RU"),
      sorter: (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
      defaultSortOrder: "descend",
    },
    { key: "user_name", header: "Кто", render: (r) => r.user_name, printValue: (r) => r.user_name },
    { key: "event_type", header: "Тип", render: (r) => <Tag>{eventTypeLabel(r.event_type)}</Tag>, printValue: (r) => r.event_type },
    { key: "area", header: "Участок", render: (r) => areaLabel(r.area), printValue: (r) => areaLabel(r.area) },
    { key: "part_unit_id", header: "Партия", render: (r) => `№${r.part_unit_id}`, printValue: (r) => r.part_unit_id },
    { key: "part_name", header: "Деталь", render: (r) => r.part_name, printValue: (r) => r.part_name },
    { key: "stage_name", header: "Этап", render: (r) => r.stage_name ?? "—", printValue: (r) => r.stage_name ?? "" },
    { key: "quantity_delta", header: "Δ шт", render: (r) => `${r.quantity_delta > 0 ? "+" : ""}${r.quantity_delta}`, printValue: (r) => r.quantity_delta },
    { key: "task_name", header: "Задание", render: (r) => r.task_name ?? "—", printValue: (r) => r.task_name ?? "" },
    {
      key: "note",
      header: "Причина / заметка",
      render: (r) => (r.write_off_reason_name ? `${r.write_off_reason_name}${r.write_off_note ? ` — ${r.write_off_note}` : ""}` : r.note ?? "—"),
      printValue: (r) => r.note ?? "",
    },
    ...(canCorrect
      ? [
          {
            key: "actions",
            header: "",
            render: (r: ActionLogPartUnitLine) => (
              <Button size="small" onClick={() => setAdjustTarget(r)}>
                Скорректировать
              </Button>
            ),
            printValue: () => "",
          },
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
        <Select
          mode="multiple"
          allowClear
          style={{ minWidth: 220 }}
          placeholder="Тип события"
          value={eventType}
          onChange={setEventType}
          options={eventTypeOptions(PART_EVENT_TYPES)}
        />
        <Select
          mode="multiple"
          allowClear
          style={{ minWidth: 200 }}
          placeholder="Участок"
          value={area}
          onChange={setArea}
          options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
        />
        <InputNumber placeholder="№ партии" value={partUnitId} onChange={(v) => setPartUnitId(v ?? undefined)} style={{ width: 130 }} />
        <Input placeholder="Поиск по заметке" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
      </Space>
      <ReportTable
        title="Журнал действий — п/ф"
        filename="zhurnal-deystviy-pf.csv"
        rowKey="id"
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
      <AdjustModal
        open={!!adjustTarget}
        title={`Скорректировать партию №${adjustTarget?.part_unit_id ?? ""}`}
        currentValue={undefined}
        unitLabel="шт"
        loading={adjustMutation.isPending}
        onCancel={() => setAdjustTarget(null)}
        onSubmit={(v) => adjustMutation.mutate(v)}
      />
    </Space>
  );
}

export default function ActionLog() {
  const { user } = useAuth();
  const canCorrectMaterial = !!user?.is_superuser || !!user?.permissions.includes("units.correct");
  const canCorrectParts = !!user?.is_superuser || !!user?.permissions.includes("part_units.correct");

  return (
    <Card title="Журнал действий">
      <Tabs
        items={[
          { key: "material", label: "Плёнка", children: <MaterialLogTab canCorrect={canCorrectMaterial} /> },
          { key: "part-units", label: "П/ф", children: <PartUnitLogTab canCorrect={canCorrectParts} /> },
        ]}
      />
    </Card>
  );
}
