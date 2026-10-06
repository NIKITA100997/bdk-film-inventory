import { useState } from "react";
import { Alert, Button, DatePicker, Select, Space, Table, Typography } from "antd";
import { PrinterOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import { useAuth } from "../../../auth/AuthContext";
import { listAreas } from "../../../api/areas";
import { getDailySheet, type DailySheetRow } from "../../../api/dailySheet";
import { printReport } from "../../../utils/printReport";
import { rollNo } from "../../../utils/lotNo";

const n = (v: number | null | undefined) => (v == null ? "" : `${Math.round(v * 100) / 100}`);

/** «Ежедневка» (06.10) — бумажный дневной бланк линии/участка в программе:
 * те же колонки, что в Ежедневка.xlsx (17 листов: окутка Северный и Фабрика,
 * ламинация, мембранные прессы), данные — из отчётов мастеров за день.
 * Получено — длина рулона при выдаче, остаток — по конец дня. */
export default function DailySheet() {
  const { user } = useAuth();
  const [area, setArea] = useState<string | undefined>(user?.area ?? undefined);
  const [lineId, setLineId] = useState<number | null>(null);
  const [day, setDay] = useState<Dayjs>(dayjs());
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const q = useQuery({
    queryKey: ["daily-sheet", area, day.format("YYYY-MM-DD"), lineId],
    queryFn: () => getDailySheet(area!, day.format("YYYY-MM-DD"), lineId),
    enabled: !!area,
  });
  const d = q.data;
  const showLine = !lineId && (d?.rows.some((r) => r.line_name) ?? false);

  const columns = [
    ...(showLine ? [{ key: "line", header: "Линия" }] : []),
    { key: "part", header: "Название детали" },
    { key: "film", header: "Цвет/материал" },
    { key: "strip", header: "Ширина штрипса" },
    { key: "roll", header: "№ штрипса" },
    { key: "received", header: "Получено метров" },
    { key: "produced", header: "Произведено всего" },
    { key: "defect", header: "Брак" },
    { key: "passed", header: "Передано в производство" },
    { key: "consumed", header: "Расход плёнки" },
    { key: "remaining", header: "Остаток метров" },
  ];
  const plain = (r: DailySheetRow) => ({
    line: r.line_name ?? "",
    part: r.part_name ?? "",
    film: r.film ?? "",
    strip: n(r.strip_width_mm),
    roll: r.roll_id ? rollNo(r.roll_id) : "",
    received: n(r.received_m),
    produced: n(r.produced),
    defect: n(r.defect),
    passed: n(r.passed),
    consumed: n(r.consumed_m),
    remaining: n(r.remaining_m),
  });
  const print = () => {
    if (!d) return;
    const title = `Ежедневка · Участок: ${d.area_name}${d.line_name ? ` — ${d.line_name}` : ""} · Дата: ${day.format("DD.MM.YYYY")}`;
    printReport(title, columns, d.rows.map(plain));
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="Участок"
          style={{ minWidth: 260 }}
          value={area}
          onChange={(v) => {
            setArea(v);
            setLineId(null);
          }}
          options={(areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
        />
        {(d?.lines.length ?? 0) > 0 && (
          <Select
            style={{ minWidth: 200 }}
            value={lineId ?? 0}
            onChange={(v) => setLineId(v || null)}
            options={[{ value: 0, label: "Все линии" }, ...(d?.lines ?? []).map((l) => ({ value: l.id, label: l.name }))]}
          />
        )}
        <DatePicker value={day} format="DD.MM.YYYY" allowClear={false} onChange={(v) => v && setDay(v)} disabledDate={(x) => x.isAfter(dayjs(), "day")} />
        <Button icon={<PrinterOutlined />} disabled={!d} onClick={print}>
          Печать бланка
        </Button>
      </Space>
      {!area && <Typography.Text type="secondary">Выберите участок.</Typography.Text>}
      {d && d.without_line > 0 && lineId != null && (
        <Alert
          type="warning"
          showIcon
          message={`За день есть отчёты без линии: ${d.without_line} — мастер не выбрал «Мою линию» в отчёте. Они видны в «Все линии».`}
        />
      )}
      {d && (
        <Table<DailySheetRow>
          size="small"
          rowKey={(r) => `${r.task_id}-${r.part_name}-${r.roll_id}-${r.line_name}`}
          loading={q.isFetching}
          dataSource={d.rows}
          pagination={false}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: "За этот день отчётов нет" }}
          columns={[
            ...(showLine ? [{ title: "Линия", render: (_: unknown, r: DailySheetRow) => r.line_name ?? "—" }] : []),
            { title: "Название детали", render: (_, r) => r.part_name ?? "—" },
            { title: "Цвет/материал", render: (_, r) => r.film ?? "—" },
            { title: "Ширина штрипса", align: "right", render: (_, r) => n(r.strip_width_mm) },
            { title: "№ штрипса", render: (_, r) => (r.roll_id ? rollNo(r.roll_id) : "—") },
            { title: "Получено, м", align: "right", render: (_, r) => n(r.received_m) },
            { title: "Произведено", align: "right", render: (_, r) => n(r.produced) },
            { title: "Брак", align: "right", render: (_, r) => n(r.defect) },
            { title: "Передано", align: "right", render: (_, r) => n(r.passed) },
            { title: "Расход плёнки, м", align: "right", render: (_, r) => n(r.consumed_m) },
            { title: "Остаток, м", align: "right", render: (_, r) => <b>{n(r.remaining_m)}</b> },
            // средний расход на годную панель — брак входит в расход (06.10)
            { title: "м на панель", align: "right", render: (_, r) => (r.passed > 0 ? n(r.consumed_m / r.passed) : "—") },
          ]}
          summary={(rows) =>
            rows.length > 1 ? (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={showLine ? 6 : 5}>
                  <b>Итого за день</b>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">{n(rows.reduce((s, r) => s + r.produced, 0))}</Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right">{n(rows.reduce((s, r) => s + r.defect, 0))}</Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right">{n(rows.reduce((s, r) => s + r.passed, 0))}</Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right">{n(rows.reduce((s, r) => s + r.consumed_m, 0))}</Table.Summary.Cell>
                <Table.Summary.Cell index={5} />
                <Table.Summary.Cell index={6} align="right">
                  {(() => {
                    const passed = rows.reduce((s, r) => s + r.passed, 0);
                    return passed > 0 ? n(rows.reduce((s, r) => s + r.consumed_m, 0) / passed) : "—";
                  })()}
                </Table.Summary.Cell>
              </Table.Summary.Row>
            ) : null
          }
        />
      )}
    </Space>
  );
}
