import { useMemo, useState } from "react";
import dayjs from "dayjs";
import { Alert, Empty, Modal, Segmented, Space, Spin, Table, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  getReleaseLayout,
  type PfPick,
  type ProductionOrder,
  type ReleaseLayoutRow,
  type ReleaseLayoutSheet,
} from "../../../api/productionOrders";

const d = (s: string | null) => (s ? dayjs(s).format("DD.MM") : "—");
const period = (a: string | null, b: string | null) => (a && b && a !== b ? `${d(a)}–${d(b)}` : d(a));

/** Характеристики двери тегами: серия, размер, цвет, кромка, стекло… */
function Chars({ row }: { row: ReleaseLayoutRow }) {
  if (!row.chars.length) return null;
  return (
    <Space size={[4, 4]} wrap>
      {row.chars.map((c) => (
        <Tag key={c.code} style={{ marginInlineEnd: 0 }}>
          {c.value === "да" ? c.name.toLowerCase() : `${c.name}: ${c.value}`}
        </Tag>
      ))}
    </Space>
  );
}

interface Agg extends ReleaseLayoutRow {
  key: string;
  lines: number;
}

/** Лист участка: «Сводно» — одинаковые позиции сложены (как листы Excel по
 * размерам), «По строкам заказа» — каждая строка со счётом и дверью. */
function SheetTable({ sheet }: { sheet: ReleaseLayoutSheet }) {
  const [mode, setMode] = useState<"sum" | "rows">("sum");
  const hasFilm = sheet.rows.some((r) => r.film);
  const data: Agg[] = useMemo(() => {
    if (mode === "rows") return sheet.rows.map((r, i) => ({ ...r, key: String(i), lines: 1 }));
    const m = new Map<string, Agg>();
    for (const r of sheet.rows) {
      const k = `${r.name}|${r.film?.label ?? ""}|${r.film?.strip_width_mm ?? ""}`;
      const a = m.get(k);
      if (a) {
        a.qty += r.qty;
        a.lines += 1;
        if (a.film && r.film) a.film = { ...a.film, need_m: Math.round((a.film.need_m + r.film.need_m) * 10) / 10 };
        if (r.date_from && (!a.date_from || r.date_from < a.date_from)) a.date_from = r.date_from;
        if (r.date_to && (!a.date_to || r.date_to > a.date_to)) a.date_to = r.date_to;
      } else m.set(k, { ...r, film: r.film ? { ...r.film } : null, key: k, lines: 1 });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [sheet, mode]);

  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <Space wrap>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as "sum" | "rows")}
          options={[
            { value: "sum", label: "Сводно" },
            { value: "rows", label: "По строкам заказа" },
          ]}
        />
        <Typography.Text type="secondary">
          Всего {sheet.total} шт · срок {period(sheet.date_from, sheet.date_to)}
          {sheet.cut_on_site && " · плёнку режут на участке — выдаётся рулон целиком"}
        </Typography.Text>
      </Space>
      <Table<Agg>
        size="small"
        rowKey="key"
        pagination={false}
        scroll={{ x: "max-content", y: 420 }}
        dataSource={data}
        columns={[
          {
            title: "Наименование",
            // п/ф — название (размер в нём уже есть); дверь — характеристики
            // крупно, длинное название мелко (модель, цвет, кромка отдельно).
            render: (_, r) =>
              r.door == null && r.chars.length ? (
                <Space direction="vertical" size={2}>
                  <Chars row={r} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.name}
                  </Typography.Text>
                </Space>
              ) : (
                <span>{r.name}</span>
              ),
          },
          { title: "Кол-во", dataIndex: "qty", align: "right", width: 80, render: (v: number) => <b>{v}</b> },
          ...(mode === "rows"
            ? [
                {
                  title: "Для двери / счёт",
                  render: (_: unknown, r: Agg) => (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {[r.door, r.note].filter(Boolean).join(" · ")}
                    </Typography.Text>
                  ),
                },
              ]
            : [{ title: "Строк", dataIndex: "lines", width: 70, align: "right" as const }]),
          ...(hasFilm
            ? [
                {
                  title: "Плёнка",
                  render: (_: unknown, r: Agg) =>
                    r.film ? (
                      <Space direction="vertical" size={0}>
                        <span>{r.film.label}</span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {r.film.strip_width_mm ? `штрипс ${r.film.strip_width_mm} мм` : "рулон, режут на участке"} · {r.film.need_m} м
                        </Typography.Text>
                      </Space>
                    ) : (
                      <Tag color="red">не определена</Tag>
                    ),
                },
              ]
            : []),
          { title: "Срок", width: 100, render: (_, r) => period(r.date_from, r.date_to) },
        ]}
      />
    </Space>
  );
}

/** Раскладка перед запуском: запуск выполняется на сервере по-настоящему и
 * откатывается — показ совпадает с тем, что родится. Листы как в
 * Excel-мониторе: по участкам в порядке сроков, плюс плёнка и материалы. */
export default function ReleaseLayoutModal({ order, picks, onClose }: { order: ProductionOrder; picks: PfPick[]; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["release-layout", order.id, JSON.stringify(picks)],
    queryFn: () => getReleaseLayout(order.id, picks),
    staleTime: 0,
    gcTime: 0,
  });
  const lay = q.data;
  return (
    <Modal open width="96vw" style={{ maxWidth: 1300, top: 16 }} title={`Раскладка запуска — заказ №${order.id} «${order.name}»`} footer={null} onCancel={onClose}>
      {q.isLoading && <Spin style={{ display: "block", margin: "48px auto" }} />}
      {q.isError && <Alert type="error" showIcon message="Не удалось посчитать раскладку" description={String((q.error as Error)?.message ?? "")} />}
      {lay && (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Typography.Text>
              Дверей: <b>{lay.doors}</b> · участков: <b>{lay.sheets.length}</b> · готово к <b>{d(lay.finish)}</b>
            </Typography.Text>
            {lay.late ? <Tag color="red">не успевает к отгрузке</Tag> : <Tag color="green">успевает</Tag>}
            <Typography.Text type="secondary">Ничего не запущено — это проверка. Запуск — кнопкой в окне запуска.</Typography.Text>
          </Space>
          {lay.warnings.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`Проверьте перед запуском: ${lay.warnings.length}`}
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {lay.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              }
            />
          ) : (
            <Alert type="success" showIcon message="Замечаний нет: плёнка определена и хватает, размеры стандартные" />
          )}
          <Tabs
            size="small"
            items={[
              ...lay.sheets.map((s) => ({
                key: s.area,
                label: (
                  <span>
                    {s.name} <Typography.Text type="secondary">{s.total}</Typography.Text>
                  </span>
                ),
                children: <SheetTable sheet={s} />,
              })),
              {
                key: "_film",
                label: "Плёнка",
                children: lay.film.length ? (
                  <Table
                    size="small"
                    rowKey={(r) => `${r.area}|${r.label}`}
                    pagination={false}
                    dataSource={lay.film}
                    columns={[
                      { title: "Участок", dataIndex: "area_name" },
                      { title: "Плёнка", dataIndex: "label" },
                      { title: "Нужно, м", dataIndex: "need_m", align: "right" },
                      {
                        title: "На складе площадки, м",
                        align: "right",
                        render: (_, r) => (
                          <Space size={4}>
                            <span>{r.stock_m}</span>
                            {r.stock_m < r.need_m ? <Tag color="red">не хватает</Tag> : <Tag color="green">хватает</Tag>}
                          </Space>
                        ),
                      },
                      {
                        title: "Как выдаётся",
                        render: (_, r) =>
                          r.cut_on_site ? `рулон не уже ${r.min_width_mm} мм, режут на участке` : `штрипсы от ${r.min_width_mm} мм, режет склад`,
                      },
                    ]}
                  />
                ) : (
                  <Empty description="Плёнки в этом запуске нет" />
                ),
              },
              {
                key: "_mat",
                label: "Материалы и комплектующие",
                children: (
                  <Table
                    size="small"
                    rowKey="name"
                    pagination={false}
                    scroll={{ y: 460 }}
                    dataSource={lay.materials}
                    columns={[
                      { title: "Наименование", dataIndex: "name" },
                      {
                        title: "Количество",
                        align: "right",
                        render: (_, r) => `${Math.round(r.qty * 100) / 100} ${r.unit ?? "шт"}`,
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </Space>
      )}
    </Modal>
  );
}
