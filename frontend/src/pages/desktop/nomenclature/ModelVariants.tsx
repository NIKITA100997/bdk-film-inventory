import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Input, Space, Table, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../../auth/AuthContext";
import { listAreas } from "../../../api/areas";
import { listItems, type Item } from "../../../api/items";
import { getItemProperties, listItemTypes } from "../../../api/itemTypes";
import { CheckModal } from "./TypeRulesPanel";

/** Варианты модели (как характеристики номенклатуры в 1С): модель — серия
 * («Щитовая дверь В-9»), вариант — размер, цвет, кромка… со своей
 * техкартой по правилам типа. «Добавить вариант» — форма типа с уже
 * выбранной серией модели. */
export default function ModelVariants({ modelId, typeId }: { modelId: number; typeId: number | null }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCreate = !!user?.is_superuser || !!user?.permissions.some((c) => c === "production_tasks.manage" || c === "materials.manage");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const itemsQuery = useQuery({ queryKey: ["items", false], queryFn: () => listItems({ include_inactive: false }) });
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes(), enabled: typeId != null });
  const modelPropsQuery = useQuery({ queryKey: ["item-properties", modelId], queryFn: () => getItemProperties(modelId) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const type = typesQuery.data?.find((t) => t.id === typeId);
  const variants = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/ё/g, "е");
    return (itemsQuery.data ?? []).filter(
      (i) => i.model_id === modelId && (!needle || i.name.toLowerCase().replace(/ё/g, "е").includes(needle)),
    );
  }, [itemsQuery.data, modelId, q]);
  const areaName = (code: string | null) =>
    code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "общий запас, с любого участка";
  // Серия модели — в форму нового варианта сразу.
  const initialValues = Object.fromEntries(Object.entries(modelPropsQuery.data?.values ?? {}).map(([k, v]) => [String(k), v]));

  return (
    <Card size="small">
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Варианты модели — размеры, цвета, кромка, стекло. У каждого своя техкарта по правилам типа
          {type ? ` «${type.name}»` : ""}. Остатки и заказы — по вариантам.
        </Typography.Text>
        <Space wrap>
          <Input.Search allowClear placeholder="Поиск по варианту" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
          {canCreate && type && (
            <Button type="primary" onClick={() => setAdding(true)} disabled={modelPropsQuery.isLoading}>
              + Добавить вариант
            </Button>
          )}
        </Space>
        <Table<Item>
          size="small"
          rowKey="id"
          loading={itemsQuery.isLoading}
          dataSource={variants}
          pagination={{ pageSize: 50, hideOnSinglePage: true }}
          locale={{ emptyText: "Вариантов пока нет" }}
          onRow={(i) => ({ onClick: () => navigate(`/item/${i.id}`), style: { cursor: "pointer" } })}
          columns={[
            { title: `Вариант (${variants.length})`, dataIndex: "name" },
            { title: "Статус", render: (_, i) => (i.is_active ? <Tag color="green">активна</Tag> : <Tag>архив</Tag>) },
          ]}
        />
      </Space>
      {adding && type && (
        <CheckModal
          type={type}
          mode="create"
          areaName={areaName}
          initialValues={initialValues}
          onClose={() => setAdding(false)}
          onCreated={(id) => navigate(`/item/${id}`)}
        />
      )}
    </Card>
  );
}
