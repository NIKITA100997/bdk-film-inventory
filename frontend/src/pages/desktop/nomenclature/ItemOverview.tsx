import { useState, type ReactNode } from "react";
import { Button, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import type { TechCard } from "../../../api/items";
import { listAreas } from "../../../api/areas";
import type { Part } from "../../../api/dictionaries";
import ItemPropertiesSection from "./ItemPropertiesSection";
import LaminatedBar from "./LaminatedBar";
import PartParamsModal from "./PartParamsModal";
import ItemPriceSection from "./ItemPriceSection";
import { useAuth } from "../../../auth/AuthContext";

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

/** «Карточка» позиции — что это за позиция: характеристики (свойства типа
 * и параметры детали одной таблицей — без повторов), цена, позиции «в
 * плёнке». Из чего делается, маршрут, работы и во что входит — на
 * вкладке «Состав» (ItemComposition). */
export default function ItemOverview({
  card,
  part,
  canEditTypes,
  canEditPart,
  canManageLaminated,
}: {
  card: TechCard;
  part: Part | null;
  canEditTypes: boolean;
  canEditPart: boolean;
  canManageLaminated: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas, enabled: !!part });
  const areaName = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const { user } = useAuth();
  const has = (code: string) => !!user?.is_superuser || !!user?.permissions.includes(code);
  const showPrice = (card.kind_code === "plenka" || card.kind_code === "material") && (has("prices.view") || has("prices.manage"));
  const showLaminated = card.kind_code === "pf" && !card.is_model;

  // Параметры детали — в той же таблице, что свойства. Размер для плёнки —
  // только у позиции без типа: у типовой он повторяет ширину и высоту.
  const partRows = part
    ? [
        ...(card.type_id ? [] : [{ label: "Размер для плёнки", value: `${part.width_mm} мм × ${part.length_m} м` }]),
        { label: "Ширина штрипса", value: part.strip_width_mm ? `${part.strip_width_mm} мм` : "по ширине детали" },
        { label: "Участок", value: areaName(part.area) },
        { label: "Мин. остаток", value: part.min_stock_pieces != null ? `${part.min_stock_pieces} шт` : "—" },
        { label: "Мин. партия", value: part.min_batch_pieces != null ? `${part.min_batch_pieces} шт` : "—" },
        { label: "Закреплённая плёнка", value: part.default_material_sku_id ? "закреплена" : "подбирается по цвету" },
      ]
    : [];

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <section>
        <ItemPropertiesSection
          itemId={card.item_id}
          kindCode={card.kind_code}
          canEdit={canEditTypes}
          title="Характеристики"
          extra={partRows}
          extraAction={
            part &&
            canEditPart && (
              <Button size="small" onClick={() => setEditing(true)}>
                Изменить параметры детали
              </Button>
            )
          }
        />
      </section>

      {showPrice && <ItemPriceSection itemId={card.item_id} kindCode={card.kind_code} canManage={has("prices.manage")} />}

      {showLaminated && (
        <section>
          <SectionHead title="В плёнке" />
          <LaminatedBar itemId={card.item_id} canManage={canManageLaminated} bare />
        </section>
      )}

      {editing && part && <PartParamsModal part={part} onClose={() => setEditing(false)} />}
    </Space>
  );
}
