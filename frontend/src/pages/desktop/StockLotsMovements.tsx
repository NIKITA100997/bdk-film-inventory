import { useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate } from "react-router-dom";
import { Button, Card, Checkbox, DatePicker, Input, InputNumber, Segmented, Select, Space, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { UnitLink, PartUnitLink } from "../../components/EntityLink";
import LotActions from "../../components/lotOps/LotActions";
import LotOperationById from "../../components/lotOps/LotOperationById";
import { useAuth } from "../../auth/AuthContext";
import ResponsiveTable from "../../components/ResponsiveTable";
import { exportToExcel } from "../../utils/excel";
import { listAreas } from "../../api/areas";
import { KIND_LABEL, listLots, listMovements, type Lot, type Movement } from "../../api/unifiedStock";
import { lotNo } from "../../utils/lotNo";

const KIND_COLOR: Record<string, string> = { plenka: "blue", pf: "orange", material: "green", fg: "purple" };
const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const num = (n: number) => String(Math.round(n * 100) / 100).replace(".", ",");
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
          { title: "Партия", render: (_, r) => lotNo(r.kind, r.lot_id) },
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
 * по событию, участку и партии, задание, причина и исправление ошибок.
 * С 08.10 — из одного журнала в базе (lot_movements): плёнка, п/ф,
 * материалы и готовые изделия, с суммами и итогами по отбору. */
export function MovementsPanel({ itemId, fixedKind, defaultDays = 7 }: { itemId?: number; fixedKind?: "plenka" | "pf"; defaultDays?: number }) {
  const navigate = useNavigate();
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
  // исправление ошибки из журнала — единое окно корректировки (06.10)
  const [adjust, setAdjust] = useState<Movement | null>(null);
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
          [m.item_name, m.event, m.user_name ?? "", m.note ?? "", m.task_name ?? "", m.reason_name ?? "", m.lot_no ?? ""].some((s) =>
            norm(s).includes(needle),
          )),
    );
  }, [ofKind, events, areas, lot, q]);
  // Итоги отбора: по виду и единице — плюс и минус; сумма ₽, если видна.
  const totals = useMemo(() => {
    const m = new Map<string, { unit: string; kind: string; plus: number; minus: number }>();
    let amount = 0;
    for (const r of rows) {
      if (r.qty_delta) {
        const key = `${r.kind}|${r.unit}`;
        const t = m.get(key) ?? { unit: r.unit, kind: r.kind, plus: 0, minus: 0 };
        if (r.qty_delta > 0) t.plus += r.qty_delta;
        else t.minus += r.qty_delta;
        m.set(key, t);
      }
      amount += r.amount_rub ?? 0;
    }
    return { byUnit: [...m.values()], amount };
  }, [rows]);
  const showAmount = rows.some((r) => r.amount_rub != null);

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
              { label: "Материалы", value: "material" },
              { label: "Изделия", value: "fg" },
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
                Партия: m.lot_no ?? "",
                ...(showAmount ? { "Сумма, ₽": m.amount_rub ?? "" } : {}),
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
      {totals.byUnit.length > 0 && (
        <Space wrap size={[16, 4]}>
          <Typography.Text type="secondary">Итого по отбору ({rows.length} строк):</Typography.Text>
          {totals.byUnit.map((t) => (
            <Typography.Text key={`${t.kind}|${t.unit}`}>
              {KIND_LABEL[t.kind]}: <Typography.Text type="success">+{num(t.plus)}</Typography.Text> /{" "}
              <Typography.Text type="danger">{num(t.minus)}</Typography.Text> {t.unit}
            </Typography.Text>
          ))}
          {showAmount && (
            <Typography.Text strong>
              сумма {totals.amount > 0 ? "+" : ""}
              {rub(totals.amount)}
            </Typography.Text>
          )}
        </Space>
      )}
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
          ...(!itemId && kind === "all"
            ? [{ title: "Вид", render: (_: unknown, m: Movement) => <Tag color={KIND_COLOR[m.kind]}>{KIND_LABEL[m.kind]}</Tag> }]
            : []),
          {
            title: "Партия",
            render: (_, m) =>
              m.lot_id == null ? "—" : m.kind === "plenka" ? <UnitLink id={m.lot_id} /> : <PartUnitLink id={m.lot_id} />,
          },
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
          ...(showAmount
            ? [
                {
                  title: "Сумма",
                  render: (_: unknown, m: Movement) =>
                    m.amount_rub ? (
                      <span style={{ fontVariantNumeric: "tabular-nums", color: m.amount_rub < 0 ? "#cf1322" : undefined }}>
                        {m.amount_rub > 0 ? "+" : ""}
                        {rub(m.amount_rub)}
                      </span>
                    ) : (
                      "—"
                    ),
                },
              ]
            : []),
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
                    (m.kind === "plenka" || m.kind === "pf") && m.lot_id != null && canCorrect(m.kind) ? (
                      <Button size="small" onClick={() => setAdjust(m)}>
                        Скорректировать
                      </Button>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
      {adjust && adjust.lot_id != null && (adjust.kind === "plenka" || adjust.kind === "pf") && (
        <LotOperationById kind={adjust.kind} id={adjust.lot_id} op="adjust" onClose={() => setAdjust(null)} />
      )}
    </Space>
  );
}
