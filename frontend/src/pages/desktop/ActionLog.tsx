import { useMemo, useState } from "react";
import { Button, Card, DatePicker, Input, InputNumber, Segmented, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import { UndoOutlined, EditOutlined, FileExcelOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  getActionLogMaterial,
  getActionLogPartUnits,
  type ActionLogMaterialLine,
  type ActionLogPartUnitLine,
} from "../../api/actionLog";
import { listAreas } from "../../api/areas";
import { useAuth } from "../../auth/AuthContext";
import { UnitLink, PartUnitLink } from "../../components/EntityLink";
import LotOperationById from "../../components/lotOps/LotOperationById";
import { exportToExcel } from "../../utils/excel";
import type { LotOp } from "../../components/lotOps/lotOps";

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

function eventTagColor(event: string): string {
  if (event.includes("Списание") || event.includes("недостача")) return "volcano";
  if (event.includes("Возврат") || event.includes("Приход") || event.includes("излишек") || event.includes("подтверждено")) return "green";
  if (event.includes("Корректировка")) return "orange";
  if (event.includes("Выдача") || event.includes("Перемещение")) return "blue";
  if (event.includes("резка") || event.includes("Раскрой") || event.includes("Производство")) return "purple";
  return "default";
}

function statusTagColor(st: string | null | undefined): string {
  if (!st) return "default";
  const norm = st.replace(/_/g, " ");
  if (norm === "Списан") return "red";
  if (norm === "На хранении" || norm === "Принят") return "green";
  if (norm === "Выдан участку") return "blue";
  return "default";
}

const eventTypeLabel = (v: string) => v.replace(/_/g, " ");
const eventTypeOptions = (values: string[]) => values.map((v) => ({ value: v, label: eventTypeLabel(v) }));

function MaterialLogTab({ canOperate }: { canOperate: boolean }) {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, "day"), dayjs()]);
  const [preset, setPreset] = useState<string>("all");
  const [eventType, setEventType] = useState<string[]>([]);
  const [area, setArea] = useState<string[]>([]);
  const [unitId, setUnitId] = useState<number | undefined>(undefined);
  const [q, setQ] = useState("");
  const [activeOp, setActiveOp] = useState<{ id: number; op: LotOp } | null>(null);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? areasQuery.data?.find((a) => a.code === code)?.name ?? code : "—");

  const effectiveEventTypes = useMemo(() => {
    if (preset === "writeoffs") return ["Списание"];
    if (preset === "adjustments") return ["Корректировка", "Возврат"];
    return eventType.length ? eventType : undefined;
  }, [preset, eventType]);

  const query = useQuery({
    queryKey: ["action-log-material", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), effectiveEventTypes, area, unitId, q],
    queryFn: () =>
      getActionLogMaterial({
        date_from: range[0].format("YYYY-MM-DD"),
        date_to: range[1].format("YYYY-MM-DD"),
        event_type: effectiveEventTypes,
        area: area.length ? area : undefined,
        unit_id: unitId,
        q: q.trim() || undefined,
        limit: 500,
      }),
  });

  const rows = query.data ?? [];

  const handleExport = () => {
    if (rows.length === 0) return;
    const exportData = rows.map((r) => ({
      "Когда": dayjs(r.timestamp).format("DD.MM.YYYY HH:mm"),
      "Кто": r.user_name,
      "Событие": eventTypeLabel(r.event_type),
      "Рулон/штрипс": r.unit_id,
      "Материал": `${r.material} ${r.color} ${r.thickness}мм`,
      "Ширина, мм": r.width_mm,
      "Δ длины, м": r.quantity_delta_m,
      "Было, м": r.from_length ?? "",
      "Стало, м": r.to_length ?? "",
      "Ячейка откуда": r.from_cell ?? "",
      "Ячейка куда": r.to_cell ?? "",
      "Текущий статус": r.unit_status ?? "",
      "Причина списания": r.write_off_reason_name ?? "",
      "Заметка": r.write_off_note ?? "",
      "Задание": r.task_name ?? "",
    }));
    exportToExcel(`Журнал_действий_пленка_${dayjs().format("YYYY-MM-DD")}`, exportData, [
      { key: "Когда", header: "Когда" },
      { key: "Кто", header: "Кто" },
      { key: "Событие", header: "Событие" },
      { key: "Рулон/штрипс", header: "Рулон/штрипс" },
      { key: "Материал", header: "Материал" },
      { key: "Ширина, мм", header: "Ширина, мм" },
      { key: "Δ длины, м", header: "Δ длины, м" },
      { key: "Было, м", header: "Было, м" },
      { key: "Стало, м", header: "Стало, м" },
      { key: "Ячейка откуда", header: "Ячейка откуда" },
      { key: "Ячейка куда", header: "Ячейка куда" },
      { key: "Текущий статус", header: "Текущий статус" },
      { key: "Причина списания", header: "Причина списания" },
      { key: "Заметка", header: "Заметка" },
      { key: "Задание", header: "Задание" },
    ]);
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap size={[12, 12]} style={{ justifyContent: "space-between", width: "100%" }}>
        <Space wrap size={[12, 12]}>
          <Segmented
            value={preset}
            onChange={(v) => {
              setPreset(v as string);
              if (v !== "all") setEventType([]);
            }}
            options={[
              { label: "Все события", value: "all" },
              { label: "🔴 Только списания", value: "writeoffs" },
              { label: "🔄 Корректировки / возвраты", value: "adjustments" },
            ]}
          />
          <DatePicker.RangePicker
            format="DD.MM.YYYY"
            value={range}
            onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
          />
          {preset === "all" && (
            <Select
              mode="multiple"
              allowClear
              style={{ minWidth: 200 }}
              placeholder="Тип события"
              value={eventType}
              onChange={setEventType}
              options={eventTypeOptions(MATERIAL_EVENT_TYPES)}
            />
          )}
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 160 }}
            placeholder="Участок"
            value={area}
            onChange={setArea}
            options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
          />
          <InputNumber
            placeholder="№ рулона"
            value={unitId}
            onChange={(v) => setUnitId(v ?? undefined)}
            style={{ width: 120 }}
          />
          <Input.Search
            allowClear
            placeholder="Поиск по заметке / причине"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 220 }}
          />
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => query.refetch()}>
            Обновить
          </Button>
          <Button icon={<FileExcelOutlined />} onClick={handleExport} disabled={rows.length === 0}>
            Экспорт в Excel
          </Button>
        </Space>
      </Space>

      <Table<ActionLogMaterialLine>
        rowKey="event_id"
        size="small"
        loading={query.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        scroll={{ x: 1200 }}
        columns={[
          {
            title: "Когда",
            dataIndex: "timestamp",
            width: 130,
            render: (v: string) => dayjs(v).format("DD.MM.YYYY HH:mm"),
            sorter: (a, b) => dayjs(a.timestamp).valueOf() - dayjs(b.timestamp).valueOf(),
            defaultSortOrder: "descend",
          },
          {
            title: "Кто",
            dataIndex: "user_name",
            width: 140,
          },
          {
            title: "Событие",
            dataIndex: "event_type",
            width: 140,
            render: (v: string) => <Tag color={eventTagColor(v)}>{eventTypeLabel(v)}</Tag>,
          },
          {
            title: "Рулон",
            dataIndex: "unit_id",
            width: 110,
            render: (id: number) => <UnitLink id={id} />,
          },
          {
            title: "Номенклатура",
            key: "sku",
            render: (_, r) => (
              <span style={{ fontSize: 13 }}>
                <strong>{r.material}</strong> {r.color} {r.thickness}мм • {r.width_mm} мм
              </span>
            ),
          },
          {
            title: "Изменение",
            key: "delta",
            width: 130,
            render: (_, r) => (
              <div>
                <Typography.Text type={r.quantity_delta_m < 0 ? "danger" : r.quantity_delta_m > 0 ? "success" : "secondary"}>
                  {r.quantity_delta_m > 0 ? `+${r.quantity_delta_m}` : r.quantity_delta_m} м
                </Typography.Text>
                {r.from_length != null && r.to_length != null && (
                  <div style={{ fontSize: 11, color: "#8c8c8c" }}>
                    {r.from_length} → {r.to_length} м
                  </div>
                )}
              </div>
            ),
          },
          {
            title: "Ячейка",
            key: "cells",
            width: 110,
            render: (_, r) =>
              r.from_cell || r.to_cell ? (
                <span style={{ fontSize: 12 }}>
                  {r.from_cell ?? "—"} → {r.to_cell ?? "—"}
                </span>
              ) : (
                r.current_location_code ?? "—"
              ),
          },
          {
            title: "Участок",
            dataIndex: "area",
            width: 120,
            render: (v: string | null) => areaLabel(v),
          },
          {
            title: "Текущий статус",
            dataIndex: "unit_status",
            width: 120,
            render: (st: string | null) => st ? <Tag color={statusTagColor(st)}>{st.replace(/_/g, " ")}</Tag> : "—",
          },
          {
            title: "Причина / заметка",
            key: "note",
            render: (_, r) => {
              const reason = r.write_off_reason_name;
              const note = r.write_off_note;
              if (!reason && !note) return "—";
              return (
                <div>
                  {reason && <Tag color="volcano">{reason}</Tag>}
                  {note && <span style={{ color: "#595959" }}>{note}</span>}
                </div>
              );
            },
          },
          {
            title: "Задание",
            dataIndex: "task_name",
            width: 140,
            render: (v: string | null, r) => v ? `${v}${r.part_name ? ` (${r.part_name})` : ""}` : "—",
          },
          ...(canOperate
            ? [
                {
                  title: "Действия",
                  key: "actions",
                  fixed: "right" as const,
                  width: 170,
                  render: (_: unknown, r: ActionLogMaterialLine) => {
                    const isWrittenOff = (r.unit_status?.replace(/_/g, " ") === "Списан") || (r.event_type === "Списание" && r.unit_status !== "На_хранении");
                    return (
                      <Space size={6}>
                        {isWrittenOff ? (
                          <Tooltip title="Отменить ошибочное списание и вернуть рулон на хранение">
                            <Button
                              size="small"
                              type="primary"
                              danger
                              icon={<UndoOutlined />}
                              onClick={() => setActiveOp({ id: r.unit_id, op: "restore" })}
                            >
                              Восстановить
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Скорректировать длину, ширину или тип">
                            <Button
                              size="small"
                              icon={<EditOutlined />}
                              onClick={() => setActiveOp({ id: r.unit_id, op: "adjust" })}
                            >
                              Править
                            </Button>
                          </Tooltip>
                        )}
                      </Space>
                    );
                  },
                },
              ]
            : []),
        ]}
      />

      {activeOp && (
        <LotOperationById
          kind="plenka"
          id={activeOp.id}
          op={activeOp.op}
          onClose={() => setActiveOp(null)}
          onDone={() => {
            setActiveOp(null);
            query.refetch();
          }}
        />
      )}
    </Space>
  );
}

function PartUnitLogTab({ canOperate }: { canOperate: boolean }) {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, "day"), dayjs()]);
  const [preset, setPreset] = useState<string>("all");
  const [eventType, setEventType] = useState<string[]>([]);
  const [area, setArea] = useState<string[]>([]);
  const [partUnitId, setPartUnitId] = useState<number | undefined>(undefined);
  const [q, setQ] = useState("");
  const [activeOp, setActiveOp] = useState<{ id: number; op: LotOp } | null>(null);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? areasQuery.data?.find((a) => a.code === code)?.name ?? code : "—");

  const effectiveEventTypes = useMemo(() => {
    if (preset === "writeoffs") return ["Списание"];
    if (preset === "adjustments") return ["Корректировка", "Возврат"];
    return eventType.length ? eventType : undefined;
  }, [preset, eventType]);

  const query = useQuery({
    queryKey: ["action-log-part-units", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), effectiveEventTypes, area, partUnitId, q],
    queryFn: () =>
      getActionLogPartUnits({
        date_from: range[0].format("YYYY-MM-DD"),
        date_to: range[1].format("YYYY-MM-DD"),
        event_type: effectiveEventTypes,
        area: area.length ? area : undefined,
        part_unit_id: partUnitId,
        q: q.trim() || undefined,
        limit: 500,
      }),
  });

  const rows = query.data ?? [];

  const handleExport = () => {
    if (rows.length === 0) return;
    const exportData = rows.map((r) => ({
      "Когда": dayjs(r.occurred_at).format("DD.MM.YYYY HH:mm"),
      "Кто": r.user_name,
      "Событие": eventTypeLabel(r.event_type),
      "Партия ПФ": r.part_unit_id,
      "Деталь": r.part_name,
      "Этап": r.stage_name ?? "",
      "Δ шт": r.quantity_delta,
      "Участок": areaLabel(r.area),
      "Текущий статус": r.unit_status ?? "",
      "Причина списания": r.write_off_reason_name ?? "",
      "Заметка": r.write_off_note ?? r.note ?? "",
      "Задание": r.task_name ?? "",
    }));
    exportToExcel(`Журнал_действий_пф_${dayjs().format("YYYY-MM-DD")}`, exportData, [
      { key: "Когда", header: "Когда" },
      { key: "Кто", header: "Кто" },
      { key: "Событие", header: "Событие" },
      { key: "Партия ПФ", header: "Партия ПФ" },
      { key: "Деталь", header: "Деталь" },
      { key: "Этап", header: "Этап" },
      { key: "Δ шт", header: "Δ шт" },
      { key: "Участок", header: "Участок" },
      { key: "Текущий статус", header: "Текущий статус" },
      { key: "Причина списания", header: "Причина списания" },
      { key: "Заметка", header: "Заметка" },
      { key: "Задание", header: "Задание" },
    ]);
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap size={[12, 12]} style={{ justifyContent: "space-between", width: "100%" }}>
        <Space wrap size={[12, 12]}>
          <Segmented
            value={preset}
            onChange={(v) => {
              setPreset(v as string);
              if (v !== "all") setEventType([]);
            }}
            options={[
              { label: "Все события", value: "all" },
              { label: "🔴 Только списания", value: "writeoffs" },
              { label: "🔄 Корректировки / возвраты", value: "adjustments" },
            ]}
          />
          <DatePicker.RangePicker
            format="DD.MM.YYYY"
            value={range}
            onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
          />
          {preset === "all" && (
            <Select
              mode="multiple"
              allowClear
              style={{ minWidth: 200 }}
              placeholder="Тип события"
              value={eventType}
              onChange={setEventType}
              options={eventTypeOptions(PART_EVENT_TYPES)}
            />
          )}
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 160 }}
            placeholder="Участок"
            value={area}
            onChange={setArea}
            options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
          />
          <InputNumber
            placeholder="№ партии"
            value={partUnitId}
            onChange={(v) => setPartUnitId(v ?? undefined)}
            style={{ width: 120 }}
          />
          <Input.Search
            allowClear
            placeholder="Поиск по заметке / причине"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 220 }}
          />
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => query.refetch()}>
            Обновить
          </Button>
          <Button icon={<FileExcelOutlined />} onClick={handleExport} disabled={rows.length === 0}>
            Экспорт в Excel
          </Button>
        </Space>
      </Space>

      <Table<ActionLogPartUnitLine>
        rowKey="id"
        size="small"
        loading={query.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        scroll={{ x: 1100 }}
        columns={[
          {
            title: "Когда",
            dataIndex: "occurred_at",
            width: 130,
            render: (v: string) => dayjs(v).format("DD.MM.YYYY HH:mm"),
            sorter: (a, b) => dayjs(a.occurred_at).valueOf() - dayjs(b.occurred_at).valueOf(),
            defaultSortOrder: "descend",
          },
          {
            title: "Кто",
            dataIndex: "user_name",
            width: 140,
          },
          {
            title: "Событие",
            dataIndex: "event_type",
            width: 140,
            render: (v: string) => <Tag color={eventTagColor(v)}>{eventTypeLabel(v)}</Tag>,
          },
          {
            title: "Партия ПФ",
            dataIndex: "part_unit_id",
            width: 110,
            render: (id: number) => <PartUnitLink id={id} />,
          },
          {
            title: "Деталь",
            dataIndex: "part_name",
            render: (v: string) => <strong>{v}</strong>,
          },
          {
            title: "Этап",
            dataIndex: "stage_name",
            width: 140,
            render: (v: string | null) => v ?? "—",
          },
          {
            title: "Δ шт",
            dataIndex: "quantity_delta",
            width: 100,
            render: (v: number) => (
              <Typography.Text type={v < 0 ? "danger" : v > 0 ? "success" : "secondary"}>
                {v > 0 ? `+${v}` : v} шт
              </Typography.Text>
            ),
          },
          {
            title: "Участок",
            dataIndex: "area",
            width: 130,
            render: (v: string | null) => areaLabel(v),
          },
          {
            title: "Текущий статус",
            dataIndex: "unit_status",
            width: 120,
            render: (st: string | null) => st ? <Tag color={statusTagColor(st)}>{st.replace(/_/g, " ")}</Tag> : "—",
          },
          {
            title: "Причина / заметка",
            key: "note",
            render: (_, r) => {
              const reason = r.write_off_reason_name;
              const note = r.write_off_note ?? r.note;
              if (!reason && !note) return "—";
              return (
                <div>
                  {reason && <Tag color="volcano">{reason}</Tag>}
                  {note && <span style={{ color: "#595959" }}>{note}</span>}
                </div>
              );
            },
          },
          {
            title: "Задание",
            dataIndex: "task_name",
            width: 130,
            render: (v: string | null) => v ?? "—",
          },
          ...(canOperate
            ? [
                {
                  title: "Действия",
                  key: "actions",
                  fixed: "right" as const,
                  width: 170,
                  render: (_: unknown, r: ActionLogPartUnitLine) => {
                    const isWrittenOff = (r.unit_status?.replace(/_/g, " ") === "Списан") || (r.event_type === "Списание" && r.unit_status !== "На_хранении");
                    return (
                      <Space size={6}>
                        {isWrittenOff ? (
                          <Tooltip title="Отменить ошибочное списание партии и вернуть на хранение">
                            <Button
                              size="small"
                              type="primary"
                              danger
                              icon={<UndoOutlined />}
                              onClick={() => setActiveOp({ id: r.part_unit_id, op: "restore" })}
                            >
                              Восстановить
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Скорректировать количество партии">
                            <Button
                              size="small"
                              icon={<EditOutlined />}
                              onClick={() => setActiveOp({ id: r.part_unit_id, op: "adjust" })}
                            >
                              Править
                            </Button>
                          </Tooltip>
                        )}
                      </Space>
                    );
                  },
                },
              ]
            : []),
        ]}
      />

      {activeOp && (
        <LotOperationById
          kind="pf"
          id={activeOp.id}
          op={activeOp.op}
          onClose={() => setActiveOp(null)}
          onDone={() => {
            setActiveOp(null);
            query.refetch();
          }}
        />
      )}
    </Space>
  );
}

export default function ActionLog() {
  const { user } = useAuth();
  const canOperateMaterial = !!user?.is_superuser || !!user?.permissions.includes("units.writeoff") || !!user?.permissions.includes("units.correct");
  const canOperateParts = !!user?.is_superuser || !!user?.permissions.includes("part_units.manage") || !!user?.permissions.includes("part_units.correct");

  return (
    <Card
      title={
        <Space>
          <span>📜 Журнал действий (ревизия и отмена операций)</span>
        </Space>
      }
    >
      <Tabs
        defaultActiveKey="material"
        items={[
          {
            key: "material",
            label: "Плёнка (рулоны и штрипсы)",
            children: <MaterialLogTab canOperate={canOperateMaterial} />,
          },
          {
            key: "part-units",
            label: "Полуфабрикаты (партии ПФ)",
            children: <PartUnitLogTab canOperate={canOperateParts} />,
          },
        ]}
      />
    </Card>
  );
}
