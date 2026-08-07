import { Card, Table } from "antd";
import { useQuery } from "@tanstack/react-query";
import { searchUnits, skuLabel, type MaterialUnit } from "../../api/units";

export default function Dashboard() {
  const query = useQuery({ queryKey: ["dashboard-units"], queryFn: () => searchUnits({}) });

  return (
    <Card title="Дашборд остатков">
      <Table<MaterialUnit>
        rowKey="id"
        loading={query.isLoading}
        dataSource={query.data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "ID", dataIndex: "id" },
          { title: "Материал", render: (_, u) => skuLabel(u.material_sku) },
          { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
          { title: "Статус", dataIndex: "status" },
          { title: "Адрес/участок", render: (_, u) => u.location_code ?? u.area ?? "—" },
        ]}
      />
    </Card>
  );
}
