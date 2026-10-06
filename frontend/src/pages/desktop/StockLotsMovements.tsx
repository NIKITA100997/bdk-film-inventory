import { useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate } from "react-router-dom";
import { Button, Card, Checkbox, DatePicker, Input, InputNumber, Segmented, Select, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AdjustModal from "../../components/AdjustModal";
import { UnitLink, PartUnitLink } from "../../components/EntityLink";
import { adjustMaterialUnit, adjustPartUnitEntry } from "../../api/actionLog";
import LotActions from "../../components/lotOps/LotActions";
import { useAuth } from "../../auth/AuthContext";
import ResponsiveTable from "../../components/ResponsiveTable";
import { exportToExcel } from "../../utils/excel";
import { listAreas } from "../../api/areas";
import { KIND_LABEL, listLots, listMovements, type Lot, type Movement } from "../../api/unifiedStock";

const KIND_COLOR: Record<string, string> = { plenka: "blue", pf: "orange" };
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Выгрузка строк-словарей: колонки — ключи первой строки. */
function exportRecords(records: Record<string, string | number>[], filename: string) {
  if (records.length === 0) return;
  const columns = Object.keys(records[0]).map((k) => ({ key: k, header: k }));
  exportToExcel(filename, records, columns);
}

/** Все партии и единицы (плёнка и п/ф) — только просмотр, клик — карточка. */
export function LotsTab() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<string>("all");
  const [area, setArea] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [q, setQ] = useState("");
  const [withWrittenOff, setWithWrittenOff] = useState(false);
  const lotsQuery = useQuery({
    queryKey: ["unified-lots", withWrittenOff],
    queryFn: () => listLots({ include_written_off: withWrittenOff }),
  });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const lots = useMemo(() => lotsQuery.data ?? [], [lotsQuery.data]);
  const statuses = useMemo(() => [...new Set(lots.map((l) => l.status))].sort(), [lots]);
  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return lots.filter(
      (l) =>
        (kind === "all" || l.kind === kind) &&
        (!area || l.area === area) &&
        (!status || l.status === status) &&
        (!needle ||
          norm(l.item_name).includes(needle) ||
          norm(l.location_code ?? "").includes(needle) ||
          String(l.lot_id) === needle.replace("№", "")),
    );
  }, [lots, kind, area, status, q]);
  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const r of rows) t[r.unit] = (t[r.unit] ?? 0) + r.qty;
    return t;
  }, [rows]);

  const exportRows = () =>
    exportRecords(
      rows.map((r) => ({
        Вид: KIND_LABEL[r.kind],
        Позиция: r.item_name,
        Партия: r.lot_id,
        Что: r.detail ?? r.stage ?? "",
        Количество: r.qty,
        Ед: r.unit,
        "м²": r.area_m2 ?? "",
        Статус: r.status,
        Участок: r.area_name ?? "",
        Место: r.location_code ?? "",
        С: r.since ?? "",
      })),
      `Остатки по партиям ${dayjs().format("DD.MM.YYYY")}`,
    );

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Space wrap size={[12, 12]}>
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as string)}
            options={[
              { label: "Все", value: "all" },
              { label: "Плёнка", value: "plenka" },
              { label: "П/ф", value: "pf" },
            ]}
          />
          <Input.Search allowClear placeholder="Позиция, место или № партии" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Участок"
            style={{ width: 240 }}
            value={area}
            onChange={setArea}
            options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
          />
          <Select allowClear placeholder="Статус" style={{ width: 180 }} value={status} onChange={setStatus} options={statuses.map((s) => ({ value: s, label: s }))} />
          <Checkbox checked={withWrittenOff} onChange={(e) => setWithWrittenOff(e.target.checked)}>
            Со списанными
          </Checkbox>
          <Button onClick={exportRows} disabled={rows.length === 0}>
            Экспорт в Excel
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ margin: "12px 0 0" }}>
          Партий: {rows.length}
          {Object.entries(totals).map(([u, v]) => ` · ${Math.round(v * 100) / 100} ${u}`)}. У выданных рулонов — остаток за вычетом
          израсходованного по отчётам; у п/ф — свободное количество.
        </Typography.Paragraph>
      </Card>
      <ResponsiveTable<Lot>
        tableKey="unified-lots"
        lockedColumns={["Позиция"]}
        size="small"
        rowKey={(r) => `${r.kind}-${r.lot_id}`}
        loading={lotsQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        onRow={(r) => ({ onClick: () => r.item_id && navigate(`/item/${r.item_id}?tab=stock`), style: { cursor: "pointer" } })}
        columns={[
          { title: "Позиция", render: (_, r) => r.item_name },
          { title: "Вид", render: (_, r) => <Tag color={KIND_COLOR[r.kind]}>{KIND_LABEL[r.kind]}</Tag> },
          { title: "Партия", render: (_, r) => `№${r.lot_id}` },
          { title: "Что", render: (_, r) => r.detail ?? (r.stage ? `этап: ${r.stage}` : "—") },
          {
            title: "Количество",
            render: (_, r) => (
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {r.qty} {r.unit}
                {r.area_m2 != null && <Typography.Text type="secondary"> · {r.area_m2} м²</Typography.Text>}
              </span>
            ),
          },
          { title: "Статус", render: (_, r) => <Tag>{r.status}</Tag> },
          { title: "Участок", render: (_, r) => r.area_name ?? "—" },
          { title: "Место", render: (_, r) => r.location_code ?? "—" },
          { title: "С", render: (_, r) => (r.since ? dayjs(r.since).format("DD.MM.YYYY") : "—") },
          // единое окно операций — для рулона и партии п/ф одинаково (06.10)
          { title: "", key: "ops", width: 120, render: (_, r) => <LotActions lot={r} /> },
        ]}
      />
    </Space>
  );
}

/** Единый журнал движений; itemId — только по одной позиции (карточка
 * позиции). Он же «Журнал действий» (объединение экранов, 29.09): фильтры
 * по событию, участку и партии, задание, причина и исправление ошибок. */
export function MovementsPanel({ itemId, fixedKind, defaultDays = 7 }: { itemId?: number; fixedKind?: "plenka" | "pf"; defaultDays?: number }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canCorrect = (k: string) =>
    !!user?.is_superuser || !!user?.permissions.includes(k === "plenka" ? "units.correct" : "part_units.correct");
  const [ownKind, setKind] = useState<string>("all");
  const kind = fixedKind ?? ownKind;
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(itemId ? null : [dayjs().subtract(defaultDays, "day"), dayjs()]);
  const [q, setQ] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [lot, setLot] = useState<number | null>(null);
  const [adjust, setAdjust] = useState<Movement | null>(null);
  const adjustMutation = useMutation({
    mutationFn: (v: { actual_value: number; reason: string; note?: string }) =>
      adjust!.kind === "plenka"
        ? adjustMaterialUnit(adjust!.lot_id, { actual_length_m: v.actual_value, reason: v.reason, note: v.note })
        : adjustPartUnitEntry(adjust!.lot_id, { actual_quantity_pieces: v.actual_value, reason: v.reason, note: v.note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unified-movements"] });
      message.success("Скорректировано");
      setAdjust(null);
    },
    onError: () => message.error("Не удалось скорректировать"),
  });
  const movesQuery = useQuery({
    queryKey: ["unified-movements", itemId, range?.[0]?.format("YYYY-MM-DD"), range?.[1]?.format("YYYY-MM-DD")],
    queryFn: () =>
      listMovements({
        item_id: itemId,
        date_from: range?.[0]?.format("YYYY-MM-DD"),
        date_to: range?.[1]?.format("YYYY-MM-DD"),
        limit: 2000,
      }),
  });
  const ofKind = useMemo(() => (movesQuery.data ?? []).filter((m) => kind === "all" || m.kind === kind), [movesQuery.data, kind]);
  // Варианты фильтров — из того, что реально есть за период.
  const eventOptions = useMemo(
    () => [...new Set(ofKind.map((m) => m.event))].sort().map((e) => ({ value: e, label: e })),
    [ofKind],
  );
  const areaOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of ofKind) if (m.area) seen.set(m.area, m.area_name ?? m.area);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru")).map(([value, label]) => ({ value, label }));
  }, [ofKind]);
  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return ofKind.filter(
      (m) =>
        (events.length === 0 || events.includes(m.event)) &&
        (areas.length === 0 || (m.area != null && areas.includes(m.area))) &&
        (lot == null || m.lot_id === lot) &&
        (!needle ||
          [m.item_name, m.event, m.user_name ?? "", m.note ?? "", m.task_name ?? "", m.reason_name ?? ""].some((s) => norm(s).includes(needle))),
    );
  }, [ofKind, events, areas, lot, q]);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap size={[12, 12]}>
        {!itemId && !fixedKind && (
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as string)}
            options={[
              { label: "Все", value: "all" },
              { label: "Плёнка", value: "plenka" },
              { label: "П/ф", value: "pf" },
            ]}
          />
        )}
        <DatePicker.RangePicker
          format="DD.MM.YYYY"
          value={range}
          onChange={(v) => setRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
          allowClear
        />
        <Select mode="multiple" allowClear placeholder="Событие" style={{ minWidth: 180 }} value={events} onChange={setEvents} options={eventOptions} />
        {!itemId && (
          <Select mode="multiple" allowClear placeholder="Участок" style={{ minWidth: 180 }} value={areas} onChange={setAreas} options={areaOptions} />
        )}
        <InputNumber placeholder="№ партии" value={lot} onChange={(v) => setLot(v ?? null)} style={{ width: 120 }} />
        <Input.Search
          allowClear
          placeholder="Позиция, событие, сотрудник, задание, заметка"
          style={{ width: 300 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button
          disabled={rows.length === 0}
          onClick={() =>
            exportRecords(
              rows.map((m) => ({
                Когда: dayjs(m.at).format("DD.MM.YYYY HH:mm"),
                Вид: KIND_LABEL[m.kind],
                Позиция: m.item_name,
                Партия: m.lot_id,
                Событие: m.event,
                Количество: m.qty_delta ?? "",
                Ед: m.unit,
                Участок: m.area_name ?? "",
                Откуда: m.from_place ?? "",
                Куда: m.to_place ?? "",
                Кто: m.user_name ?? "",
                Задание: m.task_name ?? "",
                Причина: m.reason_name ?? "",
                Заметка: m.note ?? "",
              })),
              `Движения ${dayjs().format("DD.MM.YYYY")}`,
            )
          }
        >
          Экспорт в Excel
        </Button>
      </Space>
      <ResponsiveTable<Movement>
        tableKey={itemId ? "item-movements" : "unified-movements"}
        lockedColumns={["Когда"]}
        size="small"
        rowKey={(m, i) => `${m.kind}-${m.lot_id}-${m.at}-${i}`}
        loading={movesQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Движений за период нет" }}
        columns={[
          { title: "Когда", render: (_, m) => dayjs(m.at).format("DD.MM.YYYY HH:mm") },
          ...(itemId
            ? []
            : [
                {
                  title: "Позиция",
                  render: (_: unknown, m: Movement) =>
                    m.item_id ? <a onClick={() => navigate(`/item/${m.item_id}`)}>{m.item_name}</a> : m.item_name,
                },
              ]),
          { title: "Партия", render: (_, m) => (m.kind === "plenka" ? <UnitLink id={m.lot_id} /> : <PartUnitLink id={m.lot_id} />) },
          { title: "Событие", render: (_, m) => <Tag>{m.event}</Tag> },
          {
            title: "Количество",
            render: (_, m) =>
              m.qty_delta == null || m.qty_delta === 0 ? (
                "—"
              ) : (
                <Typography.Text type={m.qty_delta < 0 ? "danger" : "success"} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {m.qty_delta > 0 ? "+" : ""}
                  {m.qty_delta} {m.unit}
                </Typography.Text>
              ),
          },
          { title: "Участок", render: (_, m) => m.area_name ?? "—" },
          { title: "Откуда → куда", render: (_, m) => (m.from_place || m.to_place ? `${m.from_place ?? "—"} → ${m.to_place ?? "—"}` : "—") },
          { title: "Кто", render: (_, m) => m.user_name ?? "—" },
          { title: "Задание", render: (_, m) => m.task_name ?? "—" },
          {
            title: "Причина / заметка",
            render: (_, m) => (m.reason_name ? `${m.reason_name}${m.note ? ` — ${m.note}` : ""}` : m.note ?? ""),
          },
          ...(canCorrect("plenka") || canCorrect("pf")
            ? [
                {
                  title: "",
                  render: (_: unknown, m: Movement) =>
                    canCorrect(m.kind) ? (
                      <Button size="small" onClick={() => setAdjust(m)}>
                        Скорректировать
                      </Button>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
      <AdjustModal
        open={!!adjust}
        title={adjust ? `Скорректировать ${adjust.kind === "plenka" ? "рулон" : "партию"} №${adjust.lot_id}` : ""}
        currentValue={adjust?.kind === "plenka" ? adjust.to_length ?? undefined : undefined}
        unitLabel={adjust?.kind === "plenka" ? "м" : "шт"}
        loading={adjustMutation.isPending}
        onCancel={() => setAdjust(null)}
        onSubmit={(v) => adjustMutation.mutate(v)}
      />
    </Space>
  );
}
