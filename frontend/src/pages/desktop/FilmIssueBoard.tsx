import { useMemo, useState } from "react";
import { Alert, Card, Empty, Input, Segmented, Select, Space, Spin, Statistic, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import ResponsiveTable from "../../components/ResponsiveTable";
import { getFilmIssueBoard, type AreaRoll, type FilmIssueLine, type FilmIssueStatus, type SiteStock } from "../../api/filmIssue";
import { useTabTitle } from "../../layout/tabTitle";
import { UnitLink } from "../../components/EntityLink";
import AreaRequestsPanel from "../../components/areaSupply/AreaRequestsPanel";
import AreaNormsPanel from "../../components/areaSupply/AreaNormsPanel";
import IssueFactPanel from "../../components/areaSupply/IssueFactPanel";

const STATUS: Record<FilmIssueStatus, { label: string; color: string }> = {
  none: { label: "не выдано", color: "red" },
  partial: { label: "выдано частично", color: "orange" },
  covered: { label: "покрыто остатком участка", color: "cyan" },
  issued: { label: "выдано", color: "green" },
  site_stock: { label: "со склада Фабрики", color: "purple" },
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const fmtD = (d: string | null) => (d ? dayjs(d).format("DD.MM") : "—");

type Row = FilmIssueLine & { area: string; area_name: string; site: string | null };
type Due = "all" | "today" | "tomorrow" | "week" | "overdue";

/** Задания на выдачу плёнки (15.10) — для кладовщика и начальника цеха:
 * по каждой строке задания с плёнкой — нужно, выдано, покрыто остатком
 * рулонов на участке (рулон участка общий для его заданий), ещё выдать и к
 * какому дню; что лежит на участках, в т.ч. остатки прошлых заданий; для
 * Фабрики — склад Фабрики против потребности и сколько переместить. */
export default function FilmIssueBoard() {
  useTabTitle("Выдача плёнки");
  const q = useQuery({ queryKey: ["film-issue-board"], queryFn: getFilmIssueBoard, refetchInterval: 120000 });
  const [area, setArea] = useState<string | null>(null);
  const [only, setOnly] = useState<"need" | "all">("need");
  const [due, setDue] = useState<Due>("all");
  const [text, setText] = useState("");

  const rows: Row[] = useMemo(
    () => (q.data?.areas ?? []).flatMap((a) => a.lines.map((l) => ({ ...l, area: a.area, area_name: a.area_name, site: a.site }))),
    [q.data],
  );
  const today = dayjs().format("YYYY-MM-DD");
  const tomorrow = dayjs().add(1, "day").format("YYYY-MM-DD");
  const week = dayjs().add(7, "day").format("YYYY-MM-DD");
  const needle = text.trim().toLowerCase();
  const shown = rows
    .filter((r) => !area || r.area === area)
    .filter((r) => only === "all" || r.status === "none" || r.status === "partial" || r.status === "site_stock")
    .filter((r) => {
      if (due === "all") return true;
      if (!r.need_by) return false;
      if (due === "overdue") return r.need_by < today && r.to_issue_m > 0;
      if (due === "today") return r.need_by <= today;
      if (due === "tomorrow") return r.need_by <= tomorrow;
      return r.need_by <= week;
    })
    .filter((r) => !needle || `${r.task_name} ${r.order_name ?? ""} ${r.part_name ?? ""} ${r.film}`.toLowerCase().includes(needle));

  const areaStats = (q.data?.areas ?? []).map((a) => {
    const cnt = (s: FilmIssueStatus) => a.lines.filter((l) => l.status === s).length;
    const rolls = (q.data?.rolls_on_areas ?? []).filter((x) => x.area === a.area);
    return {
      ...a,
      none: cnt("none"),
      partial: cnt("partial"),
      covered: cnt("covered"),
      issued: cnt("issued"),
      toIssue: a.lines.reduce((s, l) => s + l.to_issue_m2, 0),
      overdue: a.lines.filter((l) => l.need_by && l.need_by < today && l.to_issue_m > 0 && l.status !== "site_stock").length,
      onArea: rolls.reduce((s, x) => s + x.remaining_m2, 0),
    };
  });

  if (q.isLoading) return <Spin style={{ margin: 32 }} />;
  if (q.isError) return <Alert type="error" showIcon message="Не удалось загрузить доску выдачи" />;

  return (
    <Card title="Выдача плёнки">
      <Tabs
        items={[
          {
            key: "tasks",
            label: "По заданиям",
            children: (
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                <Space wrap size={[12, 12]}>
                  {areaStats.map((a) => (
                    <Card
                      key={a.area}
                      size="small"
                      hoverable
                      onClick={() => setArea(area === a.area ? null : a.area)}
                      style={{ minWidth: 260, borderColor: area === a.area ? "#c97b2d" : undefined }}
                    >
                      <div>
                        <Typography.Text strong>{a.area_name}</Typography.Text>
                        <Typography.Text type="secondary"> · {a.site ?? "—"}</Typography.Text>
                      </div>
                      <Space size={20} style={{ marginTop: 6 }} wrap>
                        {a.site === "Фабрика" ? (
                          <Statistic title="нужно, м²" value={r1(a.toIssue)} valueStyle={{ fontSize: 18 }} />
                        ) : (
                          <>
                            <Statistic title="не выдано" value={a.none} valueStyle={{ fontSize: 18, color: a.none ? "#cf1322" : undefined }} />
                            <Statistic title="частично" value={a.partial} valueStyle={{ fontSize: 18 }} />
                            <Statistic title="ещё выдать, м²" value={r1(a.toIssue)} valueStyle={{ fontSize: 18 }} />
                          </>
                        )}
                        <Statistic title="на участке, м²" value={r1(a.onArea)} valueStyle={{ fontSize: 18 }} />
                      </Space>
                      {a.overdue > 0 && (
                        <Typography.Text type="danger" style={{ fontSize: 12 }}>
                          по плану уже нужно, а не выдано: {a.overdue}
                        </Typography.Text>
                      )}
                    </Card>
                  ))}
                </Space>
                <Space wrap>
                  <Segmented
                    value={only}
                    onChange={(v) => setOnly(v as "need" | "all")}
                    options={[
                      { value: "need", label: "Требует выдачи" },
                      { value: "all", label: "Все строки" },
                    ]}
                  />
                  <Segmented
                    value={due}
                    onChange={(v) => setDue(v as Due)}
                    options={[
                      { value: "all", label: "Любой срок" },
                      { value: "overdue", label: "Просрочено" },
                      { value: "today", label: "К сегодня" },
                      { value: "tomorrow", label: "К завтра" },
                      { value: "week", label: "На неделю" },
                    ]}
                  />
                  <Select
                    allowClear
                    placeholder="Участок"
                    style={{ width: 240 }}
                    value={area ?? undefined}
                    onChange={(v) => setArea(v ?? null)}
                    options={(q.data?.areas ?? []).map((a) => ({ value: a.area, label: a.area_name }))}
                  />
                  <Input.Search allowClear placeholder="Задание, заказ, деталь, плёнка" style={{ width: 280 }} value={text} onChange={(e) => setText(e.target.value)} />
                </Space>
                {shown.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нечего выдавать по выбранным условиям" />
                ) : (
                  <ResponsiveTable<Row>
                    tableKey="film-issue-board"
                    exportTitle="Задания на выдачу плёнки"
                    size="small"
                    rowKey="line_id"
                    dataSource={shown}
                    pagination={{ pageSize: 50, showSizeChanger: true }}
                    scroll={{ x: "max-content" }}
                    columns={[
                      {
                        title: "Нужно к",
                        dataIndex: "need_by",
                        sorter: (a, b) => (a.need_by ?? "9").localeCompare(b.need_by ?? "9"),
                        render: (_, r) => (
                          <Typography.Text type={r.need_by && r.need_by < today && r.to_issue_m > 0 && r.status !== "site_stock" ? "danger" : undefined}>
                            {fmtD(r.need_by)}
                          </Typography.Text>
                        ),
                      },
                      { title: "Участок", dataIndex: "area_name" },
                      {
                        title: "Задание",
                        render: (_, r) => (
                          <Link to={`/production-tasks?task=${r.task_id}`}>
                            {r.task_name}
                            {r.order_name && r.order_name !== r.task_name ? <Typography.Text type="secondary"> · {r.order_name}</Typography.Text> : null}
                          </Link>
                        ),
                      },
                      { title: "Деталь", dataIndex: "part_name", render: (v: string | null) => v ?? "—" },
                      { title: "Плёнка", dataIndex: "film" },
                      { title: "Штрипс, мм", dataIndex: "strip_width_mm", align: "right" },
                      { title: "План / сделано, шт", align: "right", render: (_, r) => `${r1(r.quantity_pieces)} / ${r1(r.produced_pieces)}` },
                      { title: "Нужно, м", dataIndex: "need_m", align: "right", render: (v: number) => r1(v) },
                      { title: "Выдано, м", dataIndex: "issued_m", align: "right", render: (v: number) => (v ? r1(v) : "—") },
                      {
                        title: "Покрыто остатком участка, м",
                        dataIndex: "covered_by_area_m",
                        align: "right",
                        render: (v: number) => (v ? r1(v) : "—"),
                      },
                      {
                        title: "Ещё выдать",
                        align: "right",
                        sorter: (a, b) => a.to_issue_m2 - b.to_issue_m2,
                        render: (_, r) => (r.to_issue_m > 0 ? `${r1(r.to_issue_m)} м · ${r1(r.to_issue_m2)} м²` : "—"),
                      },
                      ...(q.data?.reserve_enabled
                        ? [
                            {
                              title: "Закреплено на складе, м",
                              dataIndex: "reserved_m",
                              align: "right" as const,
                              render: (v: number, r: Row) =>
                                v > 0 ? (
                                  <Typography.Text type={v + 0.01 < r.to_issue_m ? "warning" : undefined}>{r1(v)}</Typography.Text>
                                ) : r.to_issue_m > 0 ? (
                                  <Typography.Text type="secondary">нет</Typography.Text>
                                ) : (
                                  "—"
                                ),
                            },
                          ]
                        : []),
                      {
                        title: "Статус",
                        dataIndex: "status",
                        filters: (Object.keys(STATUS) as FilmIssueStatus[]).map((s) => ({ text: STATUS[s].label, value: s })),
                        onFilter: (v, r) => r.status === v,
                        render: (s: FilmIssueStatus) => <Tag color={STATUS[s].color}>{STATUS[s].label}</Tag>,
                      },
                    ]}
                  />
                )}
              </Space>
            ),
          },
          {
            key: "rolls",
            label: `На участках · ${(q.data?.rolls_on_areas ?? []).length}`,
            children: <RollsOnAreas rolls={q.data?.rolls_on_areas ?? []} />,
          },
          ...((q.data?.fabrika ?? []).length
            ? [{ key: "fabrika", label: "Фабрика: собрать и переместить", children: <Fabrika rows={q.data!.fabrika} /> }]
            : []),
          // прессы и ламинация без заданий — «закончилась — выдают» (15.10)
          { key: "requests", label: "Заявки участков", children: <AreaRequestsPanel kind="plenka" /> },
          { key: "norms", label: "Неснижаемый остаток", children: <AreaNormsPanel kind="plenka" /> },
          { key: "fact", label: "Факт резки и выдачи", children: <IssueFactPanel /> },
        ]}
      />
    </Card>
  );
}

function RollsOnAreas({ rolls }: { rolls: AreaRoll[] }) {
  const [onlyLeft, setOnlyLeft] = useState(false);
  const shown = rolls.filter((r) => !onlyLeft || (r.leftover && !!r.task_name));
  const byArea = Object.entries(
    rolls.reduce<Record<string, { n: number; m2: number; left: number }>>((acc, r) => {
      const a = (acc[r.area_name] ??= { n: 0, m2: 0, left: 0 });
      a.n += 1;
      a.m2 += r.remaining_m2;
      a.left += r.leftover && r.task_name ? 1 : 0;
      return acc;
    }, {}),
  );
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        Рулоны и штрипсы, которые числятся на участках. «Остаток прошлого задания» — задание уже закрыто, а рулон не сдали на склад: он общий
        для участка и покрывает новые задания той же плёнки, но его стоит вернуть или списать по факту. «Выдан без задания» — по запросу участка
        (прессы, ламинация).
      </Typography.Text>
      <Space wrap size={[16, 8]}>
        {byArea.map(([name, a]) => (
          <Typography.Text key={name}>
            <b>{name}</b>: {a.n} шт · {r1(a.m2)} м²{a.left ? <Typography.Text type="warning"> · прошлых заданий {a.left}</Typography.Text> : null}
          </Typography.Text>
        ))}
      </Space>
      <Segmented
        value={onlyLeft ? "left" : "all"}
        onChange={(v) => setOnlyLeft(v === "left")}
        options={[
          { value: "all", label: "Все" },
          { value: "left", label: "Только остатки прошлых заданий" },
        ]}
      />
      <ResponsiveTable<AreaRoll>
        tableKey="film-issue-rolls"
        exportTitle="Плёнка на участках"
        size="small"
        rowKey="unit_id"
        dataSource={shown}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "Участок", dataIndex: "area_name", filters: [...new Set(rolls.map((r) => r.area_name))].map((v) => ({ text: v, value: v })), onFilter: (v, r) => r.area_name === v },
          {
            title: "№",
            dataIndex: "unit_id",
            render: (v: number, r) => (
              <Space size={4}>
                <Typography.Text type="secondary">{r.is_strip ? "штрипс" : "рулон"}</Typography.Text>
                <UnitLink id={v} />
              </Space>
            ),
          },
          { title: "Плёнка", dataIndex: "film" },
          { title: "Ширина, мм", dataIndex: "width_mm", align: "right" },
          { title: "Остаток, м", dataIndex: "remaining_m", align: "right", sorter: (a, b) => a.remaining_m - b.remaining_m, render: (v: number) => r1(v) },
          { title: "м²", dataIndex: "remaining_m2", align: "right", render: (v: number) => r1(v) },
          { title: "Выдан", dataIndex: "issued_at", sorter: (a, b) => (a.issued_at ?? "").localeCompare(b.issued_at ?? ""), render: (v: string | null) => (v ? dayjs(v).format("DD.MM.YYYY") : "—") },
          { title: "Под задание", dataIndex: "task_name", render: (v: string | null) => v ?? "—" },
          {
            title: "",
            dataIndex: "leftover",
            filters: [
              { text: "остаток прошлого задания", value: "old" },
              { text: "выдан без задания", value: "free" },
            ],
            onFilter: (v, r) => (v === "old" ? r.leftover && !!r.task_name : !r.task_name),
            render: (v: boolean, r) =>
              !r.task_name ? <Tag>выдан без задания</Tag> : v ? <Tag color="gold">остаток прошлого задания</Tag> : null,
          },
        ]}
      />
    </Space>
  );
}

function Fabrika({ rows }: { rows: SiteStock[] }) {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        Фабрика работает со своего склада. Здесь — сколько плёнки нужно её открытым заданиям (по тому, что ещё не произведено), сколько
        свободно на складе Фабрики и сколько собрать на Северном и переместить. Если задания Фабрики не отчитываются, потребность завышена.
      </Typography.Text>
      <ResponsiveTable<SiteStock>
        tableKey="film-issue-fabrika"
        exportTitle="Фабрика: плёнка к перемещению"
        size="small"
        rowKey="spec_key"
        dataSource={rows}
        pagination={false}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "Плёнка", dataIndex: "film" },
          { title: "Нужно, м²", dataIndex: "need_m2", align: "right", render: (v: number) => r1(v) },
          { title: "На складе Фабрики, м²", dataIndex: "free_stock_m2", align: "right", render: (v: number) => r1(v) },
          {
            title: "Переместить с Северного, м²",
            dataIndex: "to_transfer_m2",
            align: "right",
            sorter: (a, b) => a.to_transfer_m2 - b.to_transfer_m2,
            render: (v: number) => (v > 0 ? <Typography.Text strong>{r1(v)}</Typography.Text> : <Tag color="green">хватает</Tag>),
          },
        ]}
      />
    </Space>
  );
}
