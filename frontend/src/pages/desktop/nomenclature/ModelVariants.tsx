import { useMemo, useState } from "react";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { Button, Card, Col, Input, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../../auth/AuthContext";
import { getItemProperties, listItemTypes } from "../../../api/itemTypes";
import { getModelSummary, type VariantStat } from "../../../api/modelBuilder";
import NewModelWizard from "./NewModelWizard";

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Модель (как номенклатура с характеристиками в 1С): варианты — размеры,
 * цвета, кромка — отдельные позиции (у каждого цвета свои панели и кромка
 * на складе), а история — общая: сколько заказано, сделано, в работе и в
 * браке по всем вариантам, какие цвета и размеры заказывают чаще. Новые
 * варианты — мастером или прямо из заказа на производство. */
export default function ModelVariants({ modelId, typeId }: { modelId: number; typeId: number | null }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCreate = !!user?.is_superuser || !!user?.permissions.some((c) => c === "production_tasks.manage" || c === "materials.manage");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const summaryQuery = useQuery({ queryKey: ["model-summary", modelId], queryFn: () => getModelSummary(modelId) });
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes(), enabled: typeId != null });
  const modelPropsQuery = useQuery({ queryKey: ["item-properties", modelId], queryFn: () => getItemProperties(modelId) });
  const type = typesQuery.data?.find((t) => t.id === typeId);
  const modelProp = type?.properties.find((p) => p.code === type.model_property_code);
  const optionId = modelProp ? (modelPropsQuery.data?.values[modelProp.id] as number | undefined) : undefined;
  const summary = summaryQuery.data;
  const totals = summary?.totals;
  const variants = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/ё/g, "е");
    return (summary?.variants ?? []).filter((v) => !needle || v.name.toLowerCase().replace(/ё/g, "е").includes(needle));
  }, [summary, q]);
  // Столбцы — свойства, которыми варианты различаются (серия у всех одна).
  const propColumns = useMemo(() => {
    const names = new Set<string>();
    for (const v of summary?.variants ?? []) for (const k of Object.keys(v.values)) names.add(k);
    return [...names].filter((n) => n !== modelProp?.name && new Set((summary?.variants ?? []).map((v) => v.values[n] ?? "")).size > 1);
  }, [summary, modelProp?.name]);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small">
        <Row gutter={[16, 16]}>
          <Col xs={12} md={4}>
            <Statistic title="Вариантов" value={totals?.variants ?? 0} loading={summaryQuery.isLoading} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="Заказов" value={totals?.orders ?? 0} loading={summaryQuery.isLoading} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="Заказано, шт" value={fmt(totals?.ordered ?? 0)} loading={summaryQuery.isLoading} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="Сделано, шт" value={fmt(totals?.done ?? 0)} loading={summaryQuery.isLoading} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="В работе, шт" value={fmt(totals?.in_work ?? 0)} loading={summaryQuery.isLoading} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="Брак, шт"
              value={fmt(totals?.defect ?? 0)}
              loading={summaryQuery.isLoading}
              valueStyle={totals?.defect ? { color: "#cf1322" } : undefined}
            />
          </Col>
        </Row>
        {(totals?.draft ?? 0) > 0 && (
          <Typography.Text type="secondary">Ещё в черновиках заказов: {fmt(totals?.draft ?? 0)} шт.</Typography.Text>
        )}
      </Card>

      {summary && Object.keys(summary.by_property).length > 0 && (
        <Card size="small" title="Из чего состоит модель">
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {Object.entries(summary.by_property)
              .filter(([name]) => propColumns.includes(name))
              .map(([name, vals]) => (
                <Space key={name} size={[6, 6]} wrap>
                  <Typography.Text strong style={{ minWidth: 110, display: "inline-block" }}>
                    {name}:
                  </Typography.Text>
                  {vals.map((v) => (
                    <Tag key={v.value} style={{ margin: 0 }}>
                      {v.value}{" "}
                      <Typography.Text type="secondary">
                        · вариантов {v.variants}
                        {v.ordered ? ` · заказано ${fmt(v.ordered)}` : ""}
                      </Typography.Text>
                    </Tag>
                  ))}
                </Space>
              ))}
          </Space>
        </Card>
      )}

      <Card size="small">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            Варианты — отдельные позиции (у каждого цвета свои панели и кромка на складе). Новый вариант не обязательно
            заводить заранее: в заказе на производство выберите модель — размер и цвет зададите там, вариант заведётся
            сам.
          </Typography.Text>
          <Space wrap>
            <Input.Search allowClear placeholder="Поиск по варианту" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
            {canCreate && type && (
              <Button type="primary" onClick={() => setAdding(true)} disabled={modelPropsQuery.isLoading}>
                + Добавить варианты
              </Button>
            )}
          </Space>
          <Table<VariantStat>
            size="small"
            rowKey="item_id"
            loading={summaryQuery.isLoading}
            dataSource={variants}
            pagination={{ pageSize: 50, hideOnSinglePage: true }}
            scroll={{ x: "max-content" }}
            locale={{ emptyText: "Вариантов пока нет" }}
            onRow={(v) => ({ onClick: () => navigate(`/item/${v.item_id}`), style: { cursor: "pointer" } })}
            columns={[
              {
                title: `Вариант (${variants.length})`,
                render: (_, v) => (
                  <Space size={4}>
                    <span>{v.name}</span>
                    {!v.is_active && <Tag>архив</Tag>}
                  </Space>
                ),
              },
              ...propColumns.map((name) => ({ title: name, render: (_: unknown, v: VariantStat) => v.values[name] ?? "—" })),
              { title: "Заказано", sorter: (a: VariantStat, b: VariantStat) => a.ordered - b.ordered, render: (_: unknown, v: VariantStat) => fmt(v.ordered) || "—" },
              { title: "Сделано", render: (_: unknown, v: VariantStat) => fmt(v.done) },
              {
                title: "В работе",
                render: (_: unknown, v: VariantStat) => (v.in_work ? <Tag color="blue">{fmt(v.in_work)}</Tag> : "—"),
              },
              {
                title: "Брак",
                render: (_: unknown, v: VariantStat) => (v.defect ? <Typography.Text type="danger">{fmt(v.defect)}</Typography.Text> : "—"),
              },
              {
                title: "Последний заказ",
                render: (_: unknown, v: VariantStat) => (v.last_order_at ? dayjs(v.last_order_at).format("DD.MM.YYYY") : "—"),
              },
            ]}
          />
        </Space>
      </Card>
      {adding && type && <NewModelWizard typeId={type.id} optionId={optionId} onClose={() => setAdding(false)} />}
    </Space>
  );
}
