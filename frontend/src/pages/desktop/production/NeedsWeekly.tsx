import { useMemo, useState } from "react";
import { Alert, Button, Input, Popover, Segmented, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { FileExcelOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { getNeedsWeekly, type WeekBucket, type WeekCell, type WeekRow } from "../../../api/needs";
import { usePersistentState } from "../../../hooks/usePersistentState";
import { exportToExcel } from "../../../utils/excel";

const n = (v: number) => (Math.round(v * 10) / 10).toLocaleString("ru-RU");
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Потребность по неделям (22.10): что нужно открытым заказам (клиентов и
 * на производство) на эту неделю, следующую и дальше, и хватит ли — прогноз
 * остатка на конец недели: склад + заявки с датой поставки − нужно. */
export default function NeedsWeekly() {
  const [weeks, setWeeks] = usePersistentState("needsWeekly.weeks", 6);
  const [kind, setKind] = usePersistentState<"all" | "film" | "material">("needsWeekly.kind", "all");
  const [onlyShort, setOnlyShort] = usePersistentState("needsWeekly.onlyShort", false);
  const [q, setQ] = useState("");
  const query = useQuery({ queryKey: ["needs-weekly", weeks], queryFn: () => getNeedsWeekly(weeks), staleTime: 60_000 });
  const data = query.data;

  const rows = useMemo(() => {
    const needle = norm(q.trim());
    return (data?.rows ?? []).filter(
      (r) => (kind === "all" || r.kind === kind) && (!onlyShort || r.first_short) && (!needle || norm(r.name).includes(needle)),
    );
  }, [data, kind, onlyShort, q]);

  // «Просрочено», «Позже», «Без даты» — только если там что-то есть
  const buckets = useMemo(
    () =>
      (data?.buckets ?? []).filter(
        (b) => b.start !== null && b.end !== null || rows.some((r) => (r.cells[b.key]?.need ?? 0) > 0),
      ),
    [data, rows],
  );

  const exportXlsx = () => {
    const out = rows.map((r) => {
      const rec: Record<string, string | number> = {
        name: r.name, kind: r.kind === "film" ? "плёнка" : "материал", unit: r.unit, stock: r.stock, undated: r.incoming_undated,
      };
      buckets.forEach((b, i) => {
        rec[`n${i}`] = r.cells[b.key]?.need ?? 0;
        rec[`b${i}`] = r.cells[b.key]?.balance ?? "";
      });
      return rec;
    });
    exportToExcel(
      `Потребность по неделям ${dayjs().format("DD.MM.YYYY")}.xlsx`,
      out,
      [
        { key: "name", header: "Что" }, { key: "kind", header: "Вид" }, { key: "unit", header: "Ед." },
        { key: "stock", header: "Остаток" }, { key: "undated", header: "Заказано (без даты)" },
        ...buckets.flatMap((b, i) => [
          { key: `n${i}`, header: `${b.label}: нужно` },
          { key: `b${i}`, header: `${b.label}: остаток на конец` },
        ]),
      ],
      [`Потребность по неделям — ${dayjs().format("DD.MM.YYYY HH:mm")}`],
    );
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        Сколько плёнки и материалов нужно открытым заказам — заказам клиентов (ещё не запущенное — по пробному запуску) и заказам на
        производство (по плану) — по неделям операций. Под «нужно» — прогноз остатка на конец недели: склад + заявки на закупку с датой
        поставки − нужно нарастающим итогом. Красный — не хватит.
      </Typography.Text>
      <Space wrap>
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          options={[
            { label: "Всё", value: "all" },
            { label: "Плёнка", value: "film" },
            { label: "Материалы", value: "material" },
          ]}
        />
        <Select
          value={weeks}
          onChange={setWeeks}
          style={{ width: 140 }}
          options={[4, 6, 8, 12].map((w) => ({ value: w, label: `${w} недель` }))}
        />
        <Space size={4}>
          <Switch checked={onlyShort} onChange={setOnlyShort} />
          <Typography.Text>только где не хватит</Typography.Text>
        </Space>
        <Input.Search allowClear placeholder="Поиск" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => query.refetch()}>
          Пересчитать
        </Button>
        <Button icon={<FileExcelOutlined />} disabled={!rows.length} onClick={exportXlsx}>
          Excel
        </Button>
      </Space>
      {query.isError && <Alert type="error" showIcon message="Не удалось посчитать потребность" />}
      <Table<WeekRow>
        size="small"
        rowKey="key"
        loading={query.isLoading}
        dataSource={rows}
        pagination={false}
        sticky
        scroll={{ x: "max-content" }}
        columns={[
          {
            title: "Что",
            fixed: "left",
            width: 260,
            render: (_, r) => (
              <Space size={4} wrap>
                {r.kind === "film" ? <Tag>плёнка</Tag> : <Tag color="blue">материал</Tag>}
                {r.name}
              </Space>
            ),
          },
          { title: "Остаток", align: "right", width: 100, render: (_, r) => `${n(r.stock)} ${r.unit}` },
          {
            title: "Заказано (без даты)",
            align: "right",
            width: 110,
            render: (_, r) => (r.incoming_undated > 0 ? <Tag color="purple">{n(r.incoming_undated)}</Tag> : "—"),
          },
          ...buckets.map((b) => ({
            key: b.key,
            title: <BucketTitle b={b} />,
            align: "right" as const,
            width: 120,
            render: (_: unknown, r: WeekRow) => <CellView cell={r.cells[b.key]} unit={r.unit} />,
          })),
        ]}
      />
    </Space>
  );
}

function BucketTitle({ b }: { b: WeekBucket }) {
  const [name, dates] = b.label.split(" · ");
  return (
    <div style={{ lineHeight: 1.2 }}>
      <div>{name}</div>
      {dates && <div style={{ fontWeight: 400, fontSize: 12, opacity: 0.7 }}>{dates}</div>}
    </div>
  );
}

function CellView({ cell, unit }: { cell?: WeekCell; unit: string }) {
  if (!cell) return <Typography.Text type="secondary">—</Typography.Text>;
  const short = cell.balance != null && cell.balance < -0.0005;
  const body = (
    <div style={{ lineHeight: 1.25 }}>
      <div style={{ fontWeight: cell.need > 0 ? 600 : 400 }}>{cell.need > 0 ? n(cell.need) : "—"}</div>
      {cell.balance != null && (
        <div style={{ fontSize: 12 }}>
          <Typography.Text type={short ? "danger" : "secondary"}>
            ост. {n(cell.balance)}
          </Typography.Text>
        </div>
      )}
    </div>
  );
  if (!cell.orders.length) return body;
  return (
    <Popover
      title={`Нужно ${n(cell.need)} ${unit}`}
      content={
        <Space direction="vertical" size={2}>
          {cell.orders.map((o, i) => (
            <span key={i}>
              {o.customer_order_id ? (
                <Link to={`/customer-orders/${o.customer_order_id}`}>{o.name}</Link>
              ) : (
                <Link to={`/production-orders/${o.order_id}`}>{o.name}</Link>
              )}{" "}
              — {n(o.need)} {unit}
            </span>
          ))}
        </Space>
      }
    >
      <div style={{ cursor: "pointer" }}>{body}</div>
    </Popover>
  );
}
