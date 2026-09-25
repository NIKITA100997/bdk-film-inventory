import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Space, Table, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../../auth/AuthContext";
import { getTechCard } from "../../../api/items";
import ItemPropertiesSection from "./ItemPropertiesSection";
import RouteEditorModal from "./RouteEditorModal";
import ComponentsEditorModal from "./ComponentsEditorModal";

/** Техкарта позиции — одна на любой вид: тип и свойства, маршрут по
 * участкам, состав на 1 шт и где используется (единая модель). Часть
 * карточки позиции (ItemCard). */
export default function TechCardView({ itemId }: { itemId: number }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEditTypes =
    !!user?.is_superuser ||
    !!user?.permissions.includes("production_tasks.manage") ||
    !!user?.permissions.includes("materials.manage");
  const canEditRoute = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const [routeOpen, setRouteOpen] = useState(false);
  const [componentsOpen, setComponentsOpen] = useState(false);
  const cardQuery = useQuery({ queryKey: ["techcard", itemId], queryFn: () => getTechCard(itemId) });
  const card = cardQuery.data;
  const qty = (v: number | null, unit: string) => (v == null ? "—" : `${Number(v.toFixed(3))} ${unit}`);

  return (
    <>
      {cardQuery.isLoading || !card ? (
        <Typography.Text type="secondary">Загрузка…</Typography.Text>
      ) : (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <section>
            <Typography.Title level={5}>Тип и свойства</Typography.Title>
            <ItemPropertiesSection itemId={card.item_id} kindCode={card.kind_code} canEdit={canEditTypes} />
          </section>
          {card.source_type !== "sku" && (
            <section>
              <Space style={{ justifyContent: "space-between", width: "100%" }}>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  Маршрут
                </Typography.Title>
                {canEditRoute && (
                  <Button size="small" onClick={() => setRouteOpen(true)}>
                    Изменить маршрут
                  </Button>
                )}
              </Space>
              {card.operations.length === 0 ? (
                <Typography.Text type="secondary">Операции не заданы.</Typography.Text>
              ) : (
                <ol style={{ margin: 0, paddingLeft: 20 }}>
                  {card.operations.map((o) => (
                    <li key={o.sequence_order}>
                      {o.name}
                      {o.area_name && o.area_name !== o.name && <Typography.Text type="secondary"> — {o.area_name}</Typography.Text>}
                      {!o.area &&
                        (o.sequence_order === card.operations.length ? (
                          <Typography.Text type="secondary"> — общий запас, с любого участка</Typography.Text>
                        ) : (
                          <Tag color="warning" style={{ marginLeft: 8 }}>участок не задан</Tag>
                        ))}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          {card.source_type !== "sku" && (
            <section>
              <Space style={{ justifyContent: "space-between", width: "100%" }}>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  Состав на 1 шт
                </Typography.Title>
                {canEditRoute && (
                  <Button size="small" onClick={() => setComponentsOpen(true)}>
                    Изменить состав
                  </Button>
                )}
              </Space>
              {card.inputs.length === 0 ? (
                <Typography.Text type="secondary">Состав не задан.</Typography.Text>
              ) : (
                <Table
                  size="small"
                  rowKey={(_, i) => String(i)}
                  pagination={false}
                  dataSource={card.inputs}
                  columns={[
                    {
                      title: "Что",
                      render: (_, r) => (
                        <Space size={4} wrap>
                          <span>{r.name}</span>
                          {r.source === "bom" && !r.component_item_id && <Tag color="warning">без позиции</Tag>}
                          {r.source === "bom" && r.component_item_id && <Tag>из BOM</Tag>}
                          {r.source === "manual" && <Tag color="blue">вручную</Tag>}
                          {r.source === "rule" && <Tag color="purple">по правилу</Tag>}
                        </Space>
                      ),
                    },
                    { title: "Кол-во", render: (_, r) => qty(r.qty_per_unit, r.unit) },
                    {
                      title: "Операция",
                      render: (_, r) => r.operation_name ?? <Typography.Text type="secondary">—</Typography.Text>,
                    },
                    { title: "", render: (_, r) => <Typography.Text type="secondary">{r.note}</Typography.Text> },
                  ]}
                />
              )}
            </section>
          )}
          <section>
            <Typography.Title level={5}>Где используется</Typography.Title>
            {card.used_in.length === 0 ? (
              <Typography.Text type="secondary">Нигде в составах не указана.</Typography.Text>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {card.used_in.map((u) => (
                  <li key={`${u.source_type}${u.source_id}`}>
                    {u.item_id ? <a onClick={() => navigate(`/item/${u.item_id}`)}>{u.name}</a> : u.name}
                    <Typography.Text type="secondary"> — {qty(u.qty_per_unit, card.source_type === "sku" ? "м на шт" : "шт")}</Typography.Text>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Space>
      )}
      {routeOpen && card && <RouteEditorModal card={card} onClose={() => setRouteOpen(false)} />}
      {componentsOpen && card && <ComponentsEditorModal card={card} onClose={() => setComponentsOpen(false)} />}
    </>
  );
}
