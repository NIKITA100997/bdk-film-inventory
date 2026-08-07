import { Card, Table, Typography, Empty } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getMyAreaUnits, skuLabel, type MaterialUnit } from "../../api/units";

export default function MyArea() {
  const unitsQuery = useQuery({ queryKey: ["my-area-units"], queryFn: getMyAreaUnits });

  return (
    <Card>
      <Typography.Title level={4}>Что у меня сейчас</Typography.Title>
      <Typography.Paragraph type="secondary">Единицы, числящиеся прямо сейчас за вашим участком.</Typography.Paragraph>
      <Table<MaterialUnit>
        rowKey="id"
        loading={unitsQuery.isLoading}
        dataSource={unitsQuery.data ?? []}
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: <Empty description="Пока ничего не выдано на участок" /> }}
        columns={[
          { title: "ID", dataIndex: "id" },
          { title: "Материал/цвет/толщина", render: (_, u) => skuLabel(u.material_sku) },
          { title: "Ширина×длина", render: (_, u) => `${u.width_mm}×${u.length_m}` },
        ]}
      />
    </Card>
  );
}
