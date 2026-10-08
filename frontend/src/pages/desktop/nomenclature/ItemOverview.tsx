import { useState, type ReactNode } from "react";
import { Space, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import type { TechCard } from "../../../api/items";
import { listAreas } from "../../../api/areas";
import type { Part } from "../../../api/dictionaries";
import ItemPropertiesSection from "./ItemPropertiesSection";
import LaminatedBar from "./LaminatedBar";
import ItemEditModal from "./ItemEditModal";
import ItemPriceSection from "./ItemPriceSection";
import { useAuth } from "../../../auth/AuthContext";
import { getNormatives } from "../../../api/items";
import { DIRECTIONS, MODES, STAGES } from "../../../utils/itemAttrs";

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

  const routeAreas = [...new Set(card.operations.map((o) => o.area_name ?? o.area).filter((a): a is string => !!a))];
  // Признаки позиции: свои или от типа / по правилу — помечаем, откуда.
  const fromType = <Tag style={{ marginLeft: 6, fontSize: 11 }}>из типа</Tag>;
  const attrRow = (field: "direction" | "stage" | "make_mode", label: string, dict: Record<string, string>) => {
    const v = card[field];
    if (!v) return [];
    return [{ label, value: <span>{dict[v] ?? v}{!(card.own_attrs ?? []).includes(field) && fromType}</span> }];
  };
  const attrRows = card.is_model
    ? []
    : [...attrRow("direction", "Направление", DIRECTIONS), ...attrRow("stage", "Стадия", STAGES), ...attrRow("make_mode", "Режим", MODES)];
  // Параметры детали — в той же таблице, что свойства. Размер для плёнки —
  // только у позиции без типа: у типовой он повторяет ширину и высоту.
  const partRows = part
    ? [
        ...(card.type_id ? [] : [{ label: "Размер для плёнки", value: `${part.width_mm} мм × ${part.length_m} м` }]),
        { label: "Ширина штрипса", value: part.strip_width_mm ? `${part.strip_width_mm} мм` : "по ширине детали" },
        {
          label: "Участок",
          // не закреплён — участки берутся из маршрута (вкладка «Состав»)
          value: part.area
            ? areaName(part.area)
            : routeAreas.length
              ? <span>{routeAreas.join(" → ")} <Typography.Text type="secondary">(по маршруту)</Typography.Text></span>
              : "—",
        },
        { label: "Закреплённая плёнка", value: part.default_material_sku_id ? "закреплена" : "подбирается по цвету" },
      ]
    : [];
  // Нормативы запаса (08.10) — у любой позиции, не только у детали.
  const normsQuery = useQuery({ queryKey: ["item-normatives", card.item_id], queryFn: () => getNormatives(card.item_id), enabled: !card.is_model });
  const n = normsQuery.data;
  const canEditNorms = has("production_tasks.manage") || has("materials.manage") || has("purchasing.manage");
  const normRows =
    n && (n.min_stock != null || n.min_batch != null || n.batch_multiple != null)
      ? [
          {
            label: "Нормативы",
            value: [
              n.min_stock != null ? `мин. остаток ${n.min_stock} ${n.unit ?? ""}` : null,
              n.min_batch != null ? `партия от ${n.min_batch}` : null,
              n.batch_multiple != null ? `кратно ${n.batch_multiple}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          },
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
          extra={[...attrRows, ...partRows, ...normRows]}
          onEdit={canEditTypes || (part && canEditPart) || (canEditNorms && !card.is_model) ? () => setEditing(true) : undefined}
        />
      </section>

      {showPrice && <ItemPriceSection itemId={card.item_id} kindCode={card.kind_code} canManage={has("prices.manage")} />}

      {showLaminated && (
        <section>
          <SectionHead title="В плёнке" />
          <LaminatedBar itemId={card.item_id} canManage={canManageLaminated} bare />
        </section>
      )}

      {editing && (
        <ItemEditModal
          itemId={card.item_id}
          kindCode={card.kind_code}
          typed={!!card.type_id}
          part={part}
          canEditTypes={canEditTypes}
          canEditPart={canEditPart}
          onClose={() => setEditing(false)}
        />
      )}
    </Space>
  );
}
