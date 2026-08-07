import { Card, Table, Button, Space, Typography, Tag, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAbcClasses, recomputeAbc, type WidthAbcClassEntry } from "../../api/abc";

export default function CuttingRecommendations() {
  const qc = useQueryClient();
  const classesQuery = useQuery({ queryKey: ["abc-classes", "C"], queryFn: () => listAbcClasses("C") });

  const recomputeMutation = useMutation({
    mutationFn: () => recomputeAbc(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["abc-classes"] });
      message.success(`Пересчитано позиций: ${r.updated} (период ${r.period_days} дн.)`);
    },
  });

  return (
    <Card
      title="Рекомендации по резке — штрипсы класса C"
      extra={
        <Space>
          <Button onClick={() => recomputeMutation.mutate()} loading={recomputeMutation.isPending}>
            Пересчитать ABC-классы
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        Неходовые ширины (~5% расхода за период) — кандидаты на донор-резку вместо нового рулона при выдаче участку (2.9 ТЗ).
      </Typography.Paragraph>
      <Table<WidthAbcClassEntry>
        rowKey="id"
        loading={classesQuery.isLoading}
        dataSource={classesQuery.data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
          { title: "Ширина, мм", dataIndex: "width_mm" },
          { title: "Расход за период, м", dataIndex: "total_length_m" },
          { title: "Класс", render: () => <Tag color="blue">C</Tag> },
          { title: "Пересчитано", dataIndex: "computed_at", render: (v) => new Date(v).toLocaleString("ru-RU") },
        ]}
      />
    </Card>
  );
}
