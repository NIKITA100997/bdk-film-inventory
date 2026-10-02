import { useState, type ReactNode } from "react";
import { Button, Descriptions, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import type { TechCard } from "../../../api/items";
import { listAreas } from "../../../api/areas";
import type { Part } from "../../../api/dictionaries";
import ItemPropertiesSection from "./ItemPropertiesSection";
import ItemMainTab from "./ItemMainTab";
import LaminatedBar from "./LaminatedBar";
import PartParamsModal from "./PartParamsModal";
import ComponentsEditorModal from "./ComponentsEditorModal";
import RouteEditorModal from "./RouteEditorModal";

/** Заголовок раздела карточки: название слева, одно действие справа — во
 * всех разделах одинаково. */
export function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <Space style={{ justifyContent: "space-between", width: "100%", marginBottom: 8 }} align="center">
      <Typography.Title level={5} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      {action}
    </Space>
  );
}

/** «Карточка» позиции — всё о позиции на одной вкладке, разделами по
 * порядку: свойства → параметры детали → из чего делается → маршрут → в
 * плёнке → во что идёт. У каждого раздела одна кнопка «Изменить» в
 * заголовке (раньше правка была в меню шапки, на «Главном» и на «Техкарте»
 * одновременно). */
export default function ItemOverview({
  card,
  part,
  canEditTech,
  canEditTypes,
  canEditPart,
  canManageLaminated,
}: {
  card: TechCard;
  part: Part | null;
  canEditTech: boolean;
  canEditTypes: boolean;
  canEditPart: boolean;
  canManageLaminated: boolean;
}) {
  const [editing, setEditing] = useState<"components" | "route" | "params" | null>(null);
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas, enabled: !!part });
  const areaName = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const isSku = card.source_type === "sku";
  const showLaminated = card.kind_code === "pf" && !card.is_model;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <section>
        <ItemPropertiesSection itemId={card.item_id} kindCode={card.kind_code} canEdit={canEditTypes} title="Свойства" />
      </section>

      {part && (
        <section>
          <SectionHead
            title="Параметры детали"
            action={
              canEditPart && (
                <Button size="small" onClick={() => setEditing("params")}>
                  Изменить
                </Button>
              )
            }
          />
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              { key: "size", label: "Размер для плёнки", children: `${part.width_mm} мм × ${part.length_m} м` },
              { key: "strip", label: "Ширина штрипса", children: part.strip_width_mm ? `${part.strip_width_mm} мм` : "по ширине детали" },
              { key: "area", label: "Участок", children: areaName(part.area) },
              { key: "min", label: "Мин. остаток", children: part.min_stock_pieces != null ? `${part.min_stock_pieces} шт` : "—" },
              { key: "batch", label: "Мин. партия", children: part.min_batch_pieces != null ? `${part.min_batch_pieces} шт` : "—" },
              { key: "film", label: "Закреплённая плёнка", children: part.default_material_sku_id ? "закреплена" : "подбирается по цвету" },
            ]}
          />
        </section>
      )}

      {!isSku && (
        <ItemMainTab
          card={card}
          canEdit={canEditTech}
          onEditComponents={() => setEditing("components")}
          onEditRoute={() => setEditing("route")}
          beforeUsedIn={
            showLaminated ? (
              <section>
                <SectionHead title="В плёнке" />
                <LaminatedBar itemId={card.item_id} canManage={canManageLaminated} bare />
              </section>
            ) : null
          }
        />
      )}

      {isSku && (
        <section>
          <SectionHead title="Во что идёт" />
          {card.used_in.length === 0 ? (
            <Typography.Text type="secondary">Ни в одном составе не используется.</Typography.Text>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {card.used_in.map((u) => (
                <li key={`${u.source_type}${u.source_id}`}>
                  {u.name}
                  <Typography.Text type="secondary"> — {u.qty_per_unit ?? "—"} м на шт</Typography.Text>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {editing === "params" && part && <PartParamsModal part={part} onClose={() => setEditing(null)} />}
      {editing === "components" && <ComponentsEditorModal card={card} onClose={() => setEditing(null)} />}
      {editing === "route" && <RouteEditorModal card={card} onClose={() => setEditing(null)} />}
    </Space>
  );
}
