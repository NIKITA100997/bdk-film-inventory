import { useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, Checkbox, DatePicker, Input, Segmented, Select, Space, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import { exportToExcel } from "../../utils/excel";
import { listAreas } from "../../api/areas";
import { KIND_LABEL, listLots, listMovements, type Lot, type Movement } from "../../api/unifiedStock";
import GeneralStock from "./GeneralStock";

const KIND_COLOR: Record<string, string> = { plenka: "blue", pf: "orange" };
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Выгрузка строк-словарей: колонки — ключи первой строки. */
function exportRecords(records: Record<string, string | number>[], filename: string) {
  if (records.length === 0) return;
  const columns = Object.keys(records[0]).map((k) => ({ key: k, header: k }));
  exportToExcel(filename, records, columns);
}

/** Остатки (этап 5 единой модели) — плёнка и п/ф в одном месте:
 * «По позициям» (свод по позиции), «По партиям» (каждый рулон, штрипс,
 * партия п/ф) и «Движения» (единый журнал). Клик — карточка позиции.
 * Вкладка — в адресе (?tab=). */
export default function UnifiedStock() {
  const [params, setParams] = useSearchParams();
  const tabs = [
    { key: "items", label: "По позициям", children: <GeneralStock /> },
    { key: "lots", label: "По партиям", children: <LotsTab /> },
    { key: "movements", label: "Движения", children: <MovementsPanel /> },
  ];
  const active = tabs.some((t) => t.key === params.get("tab")) ? (params.get("tab") as string) : "items";
  return <Tabs activeKey={active} onChange={(k) => setParams(k === "items" ? {} : { tab: k })} items={tabs} destroyOnHidden />;
}

function LotsTab() {
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
        ]}
      />
    </Space>
  );
}

/** Единый журнал движений; itemId — только по одной позиции (карточка позиции). */
export function MovementsPanel({ itemId }: { itemId?: number }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<string>("all");
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(itemId ? null : [dayjs().subtract(7, "day"), dayjs()]);
  const [q, setQ] = useState("");
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
  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return (movesQuery.data ?? []).filter(
      (m) =>
        (kind === "all" || m.kind === kind) &&
        (!needle || norm(m.item_name).includes(needle) || norm(m.event).includes(needle) || norm(m.user_name ?? "").includes(needle)),
    );
  }, [movesQuery.data, kind, q]);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap size={[12, 12]}>
        {!itemId && (
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
        <Input.Search allowClear placeholder="Позиция, событие или сотрудник" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
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
          { title: "Партия", render: (_, m) => `№${m.lot_id}` },
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
          { title: "Заметка", render: (_, m) => m.note ?? "" },
        ]}
      />
    </Space>
  );
}
