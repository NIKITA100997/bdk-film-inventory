import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  Card,
  Tag,
  Button,
  Space,
  InputNumber,
  Select,
  Typography,
  Alert,
  message,
} from "antd";
import {
  ShoppingCartOutlined,
  ReloadOutlined,
  FileExcelOutlined,
} from "@ant-design/icons";
import { getMrpNeeds, createMrpOrderBatch, type MrpItemNeed } from "../../../api/purchasing";
import { exportToExcel } from "../../../utils/excel";

const { Text } = Typography;

export const MrpNeedsTab: React.FC = () => {
  const qc = useQueryClient();
  const [horizonDays, setHorizonDays] = useState<number>(14);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [customQuantities, setCustomQuantities] = useState<Record<string, number>>({});

  const { data: needs = [], isLoading, isFetching, refetch } = useQuery<MrpItemNeed[]>({
    queryKey: ["mrpNeeds", horizonDays],
    queryFn: () => getMrpNeeds(horizonDays),
  });

  const orderMutation = useMutation({
    mutationFn: (items: Array<Partial<MrpItemNeed> & { suggested_order: number }>) =>
      createMrpOrderBatch(items, true),
    onSuccess: (res) => {
      message.success(
        `Создано ${res.created_requests_count} заявок и ${res.created_supplier_orders_count} заказов поставщикам!`
      );
      setSelectedRowKeys([]);
      qc.invalidateQueries({ queryKey: ["mrpNeeds"] });
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["supplier-orders"] });
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail || "Ошибка создания заказов MRP");
    },
  });

  const getRowKey = (record: MrpItemNeed) =>
    record.item_type === "film"
      ? `film-${record.material_id}-${record.color_id}-${record.thickness_id}-${record.width_mm}`
      : `material-${record.item_id}`;

  const handleOrderSelected = () => {
    if (selectedRowKeys.length === 0) {
      message.warning("Выберите позиции для заказа");
      return;
    }
    const selectedItems = needs.filter((item) => selectedRowKeys.includes(getRowKey(item)));
    const payload = selectedItems.map((item) => {
      const key = getRowKey(item);
      const qty = customQuantities[key] ?? item.suggested_order;
      return {
        ...item,
        suggested_order: qty,
      };
    });
    orderMutation.mutate(payload);
  };

  const columns = [
    {
      title: "Срочность",
      dataIndex: "urgency",
      key: "urgency",
      width: 110,
      render: (urgency: string) => {
        if (urgency === "critical") return <Tag color="error">Критично</Tag>;
        if (urgency === "warning") return <Tag color="warning">Внимание</Tag>;
        return <Tag color="blue">Планово</Tag>;
      },
    },
    {
      title: "Тип",
      dataIndex: "item_type",
      key: "item_type",
      width: 90,
      render: (t: string) => (t === "film" ? <Tag color="geekblue">Плёнка</Tag> : <Tag>Расходник</Tag>),
    },
    {
      title: "Наименование / Декор",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: MrpItemNeed) => (
        <div>
          <Text strong>{text}</Text>
          {record.supplier_name && (
            <div style={{ fontSize: 11, color: "#8c8c8c" }}>
              Поставщик: {record.supplier_name}
            </div>
          )}
        </div>
      ),
    },
    {
      title: "Потребность (валовая)",
      dataIndex: "gross_demand",
      key: "gross_demand",
      align: "right" as const,
      render: (val: number, r: MrpItemNeed) => `${val.toFixed(1)} ${r.unit}`,
    },
    {
      title: "Остаток",
      dataIndex: "stock_current",
      key: "stock_current",
      align: "right" as const,
      render: (val: number, r: MrpItemNeed) => (
        <span style={{ color: val <= 0 ? "#cf1322" : "inherit" }}>
          {val.toFixed(1)} {r.unit}
        </span>
      ),
    },
    {
      title: "В пути",
      dataIndex: "in_transit",
      key: "in_transit",
      align: "right" as const,
      render: (val: number, r: MrpItemNeed) => (val > 0 ? `${val.toFixed(1)} ${r.unit}` : "—"),
    },
    {
      title: "Страховой запас",
      dataIndex: "safety_stock",
      key: "safety_stock",
      align: "right" as const,
      render: (val: number, r: MrpItemNeed) => `${val.toFixed(1)} ${r.unit}`,
    },
    {
      title: "Чистый дефицит",
      dataIndex: "net_deficit",
      key: "net_deficit",
      align: "right" as const,
      render: (val: number, r: MrpItemNeed) => (
        <Text strong style={{ color: "#cf1322" }}>
          {val.toFixed(1)} {r.unit}
        </Text>
      ),
    },
    {
      title: "Рекомендуемый заказ",
      key: "suggested_order",
      align: "right" as const,
      width: 170,
      render: (_: any, record: MrpItemNeed) => {
        const key = getRowKey(record);
        const currentVal = customQuantities[key] ?? record.suggested_order;
        return (
          <InputNumber
            size="small"
            min={1}
            value={currentVal}
            onChange={(val) => {
              if (val !== null) {
                setCustomQuantities((prev) => ({ ...prev, [key]: Number(val) }));
              }
            }}
            addonAfter={record.unit}
            style={{ width: 130 }}
          />
        );
      },
    },
    {
      title: "Нужно к",
      dataIndex: "need_by",
      key: "need_by",
      width: 110,
      render: (val: string | null) => (val ? new Date(val).toLocaleDateString("ru-RU") : "—"),
    },
  ];

  const criticalCount = needs.filter((n) => n.urgency === "critical").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card size="small">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <Space wrap>
            <Text strong>Горизонт потребности:</Text>
            <Select
              value={horizonDays}
              onChange={(val) => setHorizonDays(val)}
              options={[
                { label: "7 дней (ближайшая неделя)", value: 7 },
                { label: "14 дней (2 недели — оптимум)", value: 14 },
                { label: "30 дней (месячный план)", value: 30 },
              ]}
              style={{ width: 220 }}
            />
            <Button
              icon={<ReloadOutlined spin={isFetching} />}
              onClick={() => refetch()}
            >
              Пересчитать
            </Button>
          </Space>

          <Space wrap>
            <Button
              icon={<FileExcelOutlined />}
              disabled={needs.length === 0}
              onClick={() =>
                exportToExcel(
                  `mrp_deficit_${horizonDays}d.xlsx`,
                  needs.map((n) => ({
                    urgency: n.urgency,
                    type: n.item_type,
                    name: n.name,
                    gross: n.gross_demand,
                    stock: n.stock_current,
                    in_transit: n.in_transit,
                    safety: n.safety_stock,
                    deficit: n.net_deficit,
                    suggested: customQuantities[getRowKey(n)] ?? n.suggested_order,
                    unit: n.unit,
                    supplier: n.supplier_name ?? "",
                    need_by: n.need_by ?? "",
                  })),
                  [
                    { key: "urgency", header: "Срочность" },
                    { key: "type", header: "Тип" },
                    { key: "name", header: "Наименование" },
                    { key: "gross", header: "Валовая потребность" },
                    { key: "stock", header: "Остаток" },
                    { key: "in_transit", header: "В пути" },
                    { key: "safety", header: "Страх. запас" },
                    { key: "deficit", header: "Чистый дефицит" },
                    { key: "suggested", header: "Рекоменд. заказ" },
                    { key: "unit", header: "Ед. изм." },
                    { key: "supplier", header: "Поставщик" },
                    { key: "need_by", header: "Нужно к" },
                  ]
                )
              }
            >
              Excel
            </Button>

            <Button
              type="primary"
              icon={<ShoppingCartOutlined />}
              disabled={selectedRowKeys.length === 0}
              loading={orderMutation.isPending}
              onClick={handleOrderSelected}
              style={{ background: "#52c41a", borderColor: "#52c41a" }}
            >
              ⚡ Заказать выбранное ({selectedRowKeys.length})
            </Button>
          </Space>
        </div>
      </Card>

      {criticalCount > 0 && (
        <Alert
          type="error"
          showIcon
          message={
            <span>
              Обнаружено <strong>{criticalCount} критических позиций</strong> дефицита (потребность в пределах 48 часов)!
              Рекомендуется немедленно разместить заказы поставщикам.
            </span>
          }
        />
      )}

      <Table
        rowKey={getRowKey}
        loading={isLoading}
        dataSource={needs}
        columns={columns}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys),
        }}
        pagination={{ pageSize: 20 }}
        size="small"
      />
    </div>
  );
};

export default MrpNeedsTab;
