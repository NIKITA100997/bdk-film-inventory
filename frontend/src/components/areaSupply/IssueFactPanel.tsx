import { Alert, Table, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { getIssueFact, type IssueFactDay } from "../../api/areaSupply";

/** Факт резки и выдачи плёнки по дням (15.10) — основа для мощности участка
 * выдачи: сколько м² сняли с рулонов резкой (по станкам, если указан) и
 * сколько выдали участкам. */
export default function IssueFactPanel() {
  const q = useQuery({ queryKey: ["issue-fact"], queryFn: () => getIssueFact(14) });
  const lines = q.data?.lines ?? [];
  const extra = [...new Set((q.data?.days ?? []).flatMap((d) => Object.keys(d.by_line)))].filter((n) => !lines.includes(n));
  const cols = [...lines, ...extra];
  const days = q.data?.days ?? [];
  const avg = (f: (d: IssueFactDay) => number) => (days.length ? Math.round((days.reduce((s, d) => s + f(d), 0) / days.length) * 10) / 10 : 0);
  return (
    <>
      {lines.length === 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="Станки резки не заведены"
          description="В Настройках → Участки и линии отметьте у участка «Здесь режут и выдают плёнку» и заведите его линии — станки. Тогда при резке можно будет указать станок, а здесь — видеть выработку по каждому."
        />
      )}
      <Typography.Paragraph type="secondary">
        За {days.length} дн. с движением в среднем: нарезано {avg((d) => d.cut_m2)} м² за день, выдано участкам {avg((d) => d.issued_m2)} м².
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey="day"
        loading={q.isLoading}
        dataSource={days}
        pagination={false}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "День", dataIndex: "day", render: (v: string) => dayjs(v).format("dd DD.MM") },
          { title: "Резок", dataIndex: "cut_ops", align: "right" },
          { title: "Нарезано, м²", dataIndex: "cut_m2", align: "right" },
          ...cols.map((n) => ({ title: n, align: "right" as const, render: (_: unknown, d: IssueFactDay) => d.by_line[n] ?? "—" })),
          { title: "Выдано участкам, шт", dataIndex: "issued_units", align: "right" },
          { title: "Выдано, м²", dataIndex: "issued_m2", align: "right" },
        ]}
      />
    </>
  );
}
