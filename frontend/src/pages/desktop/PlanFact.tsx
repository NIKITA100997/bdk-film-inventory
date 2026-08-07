import { useState } from "react";
import { Card, Space, Button, Table, Progress } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listWeeklyPlans, getPlanFact, type PlanFactLine } from "../../api/plans";

export default function PlanFact() {
  const [weekId, setWeekId] = useState<number | null>(null);
  const plansQuery = useQuery({ queryKey: ["weekly-plans"], queryFn: listWeeklyPlans });
  const factQuery = useQuery({
    queryKey: ["plan-fact", weekId],
    queryFn: () => getPlanFact(weekId!),
    enabled: !!weekId,
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="План/факт">
        <Space wrap>
          {(plansQuery.data ?? []).map((p) => (
            <Button key={p.id} type={p.id === weekId ? "primary" : "default"} onClick={() => setWeekId(p.id)}>
              {p.week_start} — {p.week_end}
            </Button>
          ))}
        </Space>
      </Card>

      {weekId && (
        <Card loading={factQuery.isLoading}>
          <Table<PlanFactLine>
            rowKey="line_id"
            dataSource={factQuery.data?.lines ?? []}
            pagination={false}
            columns={[
              { title: "Материал", render: (_, l) => `${l.material}, ${l.color}, ${l.thickness} мм` },
              { title: "План, м²", dataIndex: "planned_area_m2" },
              { title: "Факт, м²", dataIndex: "actual_area_m2" },
              {
                title: "% выполнения",
                render: (_, l) => <Progress percent={Math.min(l.percent_complete, 100)} status={l.percent_complete >= 100 ? "success" : "active"} />,
              },
            ]}
            expandable={{
              rowExpandable: (l) => Object.keys(l.by_width).length > 0,
              expandedRowRender: (l) => (
                <Table
                  size="small"
                  pagination={false}
                  dataSource={Object.entries(l.by_width).map(([width, length]) => ({ width, length }))}
                  rowKey="width"
                  columns={[
                    { title: "Ширина, мм", dataIndex: "width" },
                    { title: "Метры", dataIndex: "length" },
                  ]}
                />
              ),
            }}
          />
        </Card>
      )}
    </Space>
  );
}
