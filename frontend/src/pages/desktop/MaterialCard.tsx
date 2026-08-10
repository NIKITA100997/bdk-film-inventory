import { useEffect, useMemo, useState } from "react";
import { Card, Select, Row, Col, Statistic, Table, Space, Progress, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { listMaterialSkus } from "../../api/dictionaries";
import { getMaterialCard } from "../../api/materialCards";
import { skuLabel } from "../../api/units";

interface MaterialCardPrefill {
  material?: string;
  color?: string;
  thickness?: number;
}

export default function MaterialCard() {
  const location = useLocation();
  const navigate = useNavigate();
  const [skuId, setSkuId] = useState<number | null>(null);
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });

  useEffect(() => {
    const prefill = location.state as MaterialCardPrefill | null;
    if (!prefill || !skusQuery.data || skuId !== null) return;
    const match = skusQuery.data.find(
      (s) => s.material.name === prefill.material && s.color.name === prefill.color && s.thickness.value_mm === prefill.thickness,
    );
    if (match) setSkuId(match.id);
    // Приходим сюда по клику из агрегатной строки "Материалы" (2.2 раздел
    // бэклога доработок) — предвыбираем первую подходящую позицию по
    // материалу/цвету/толщине (без учёта производителя, как и сама агрегация).
  }, [location.state, skusQuery.data, skuId]);
  const cardQuery = useQuery({
    queryKey: ["material-card", skuId],
    queryFn: () => getMaterialCard(skuId!),
    enabled: !!skuId,
  });

  const byWidth = useMemo(() => {
    if (!cardQuery.data) return [];
    const groups = new Map<number, { width_mm: number; length_m: number; locations: Set<string> }>();
    for (const u of cardQuery.data.units) {
      const g = groups.get(u.width_mm) ?? { width_mm: u.width_mm, length_m: 0, locations: new Set() };
      g.length_m += u.length_m;
      g.locations.add(u.location_code ?? u.area ?? "—");
      groups.set(u.width_mm, g);
    }
    return [...groups.values()].sort((a, b) => b.width_mm - a.width_mm);
  }, [cardQuery.data]);

  const statusCounts = useMemo(() => {
    if (!cardQuery.data) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const u of cardQuery.data.units) counts[u.status] = (counts[u.status] ?? 0) + 1;
    return counts;
  }, [cardQuery.data]);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Карточка материала">
        <Select
          style={{ width: 420 }}
          placeholder="Выберите позицию материала"
          loading={skusQuery.isLoading}
          options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
          onChange={setSkuId}
        />
      </Card>

      {cardQuery.data && (
        <>
          <Card>
            <Row gutter={16}>
              <Col span={8}>
                <Statistic title="Общий остаток" value={cardQuery.data.total_area_m2} suffix="м²" />
              </Col>
              <Col span={8}>
                {cardQuery.data.plan_fact ? (
                  <>
                    <Statistic
                      title="Факт/план недели"
                      value={`${cardQuery.data.plan_fact.actual_area_m2} / ${cardQuery.data.plan_fact.planned_area_m2} м²`}
                    />
                    <Progress percent={Math.min(cardQuery.data.plan_fact.percent_complete, 100)} size="small" />
                  </>
                ) : (
                  <Statistic title="Факт/план недели" value="нет плана на неделю" />
                )}
              </Col>
              <Col span={8}>
                <Statistic title="Ширин в наличии" value={byWidth.length} />
              </Col>
            </Row>
          </Card>

          <Card title="Остатки по ширинам — где физически искать">
            <Table
              rowKey="width_mm"
              pagination={false}
              dataSource={byWidth}
              columns={[
                { title: "Ширина, мм", dataIndex: "width_mm" },
                { title: "Метры", dataIndex: "length_m" },
                { title: "Местоположение", render: (_, r) => [...r.locations].join(", ") },
              ]}
            />
          </Card>

          <Card title="Разбивка по статусам">
            <Space>
              {Object.entries(statusCounts).map(([status, count]) => (
                <Tag key={status}>
                  {status}: {count}
                </Tag>
              ))}
            </Space>
          </Card>

          <Card title="Список физических единиц">
            <Table
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              dataSource={cardQuery.data.units}
              onRow={(u) => ({
                onClick: () => navigate("/m/unit-card", { state: { unitId: u.id } }),
                style: { cursor: "pointer" },
              })}
              columns={[
                { title: "ID", dataIndex: "id" },
                { title: "Ширина×длина", render: (_, u) => `${u.width_mm}×${u.length_m}` },
                { title: "Статус", dataIndex: "status" },
                { title: "Адрес/участок", render: (_, u) => u.location_code ?? u.area ?? "—" },
              ]}
            />
          </Card>

          <Card title="Журнал движений">
            <Table
              rowKey="event_id"
              size="small"
              pagination={{ pageSize: 10 }}
              dataSource={cardQuery.data.events}
              columns={[
                { title: "Когда", dataIndex: "timestamp", render: (v) => new Date(v).toLocaleString("ru-RU") },
                { title: "Событие", dataIndex: "event_type" },
                { title: "Ед.", dataIndex: "unit_id" },
                { title: "Δ метры", dataIndex: "quantity_delta_m" },
              ]}
            />
          </Card>
        </>
      )}
    </Space>
  );
}
