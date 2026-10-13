import { useState } from "react";
import { Button, Empty, Input, InputNumber, Segmented, Select, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import VariantPicker from "./VariantPicker";
import { listItems, type Item } from "../api/items";
import { listItemTypes, type ItemType } from "../api/itemTypes";
import { listAreas } from "../api/areas";
import { CheckModal } from "../pages/desktop/nomenclature/TypeRulesPanel";

export type LineDraft = { item_id: number | null; quantity: number | null; note: string; invoice_no: string };

export const emptyLine = (): LineDraft => ({ item_id: null, quantity: null, note: "", invoice_no: "" });

/** Позиции заказа: изделие (модель → вариант размер/цвет/кромка — есть —
 * берётся, нет — заводится сам) или п/ф и прочее; количество, примечание,
 * при надобности — счёт 1С строки. Общий для заказа клиента и заказа на
 * производство. */
export default function ItemLinesEditor({
  lines,
  onChange,
  withInvoice = false,
  initialKind = "izdelie",
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  withInvoice?: boolean;
  initialKind?: "izdelie" | "other";
}) {
  const itemsQuery = useQuery({ queryKey: ["items", false], queryFn: () => listItems({ include_inactive: false }) });
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const [picking, setPicking] = useState<{ line: number; model: Item } | null>(null);
  const [pickKind, setPickKind] = useState<"izdelie" | "other">(initialKind);
  // Позиции нет и модели нет — «Новая позиция по типу» прямо отсюда; без
  // права на номенклатуру сохранение уйдёт запросом администратору.
  const [newOfType, setNewOfType] = useState<ItemType | null>(null);
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas, enabled: !!newOfType });
  const creatableTypes = (typesQuery.data ?? []).filter(
    (t) => t.is_active && !!t.name_template && (pickKind === "izdelie" ? t.kind_code === "izdelie" : t.kind_code !== "izdelie"),
  );
  const patch = (i: number, p: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const items = itemsQuery.data ?? [];
  const typeName = (id: number | null | undefined) => (id ? typesQuery.data?.find((t) => t.id === id)?.name : undefined);
  // Двери и п/ф в одном заказе почти не встречаются — список делится:
  // изделия по моделям (модель → её варианты), п/ф и прочее по типу.
  const orderable = items.filter((i) => i.kind_code !== "plenka" && i.kind_code !== "material");
  const isProduct = (i: Item) => i.kind_code === "izdelie";
  const groupBy = (list: Item[], key: (i: Item) => string) => {
    const m = new Map<string, Item[]>();
    for (const i of list) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"));
  };
  const modelName = (id: number | null) => items.find((m) => m.id === id)?.name;
  const itemOptions =
    pickKind === "izdelie"
      ? [
          {
            label: "Модели — выбрать размер и цвет",
            options: orderable
              .filter((i) => isProduct(i) && i.is_model && i.type_id)
              .map((i) => ({ value: i.id, label: `${i.name} — выбрать вариант…` })),
          },
          ...groupBy(
            orderable.filter((i) => isProduct(i) && !i.is_model),
            (i) => modelName(i.model_id) ?? typeName(i.type_id) ?? "Без модели",
          ).map(([label, list]) => ({ label, options: list.map((i) => ({ value: i.id, label: i.name })) })),
        ]
      : [
          {
            label: "Модели — выбрать вариант",
            options: orderable
              .filter((i) => !isProduct(i) && i.is_model && i.type_id)
              .map((i) => ({ value: i.id, label: `${i.name} — выбрать вариант…` })),
          },
          ...groupBy(
            orderable.filter((i) => !isProduct(i) && !i.is_model),
            (i) => typeName(i.type_id) ?? i.kind_name,
          ).map(([label, list]) => ({ label, options: list.map((i) => ({ value: i.id, label: i.name })) })),
        ].filter((g) => g.options.length > 0);
  // Уже выбранная позиция из другой половины списка — показываем подписью.
  const optionsFor = (itemId: number | null) => {
    const it = itemId != null ? items.find((x) => x.id === itemId) : undefined;
    if (!it || itemOptions.some((g) => g.options.some((o) => o.value === it.id))) return itemOptions;
    return [{ label: "Выбрано", options: [{ value: it.id, label: it.name }] }, ...itemOptions];
  };

  return (
    <>
      <Space wrap>
        <Typography.Text strong>Позиции</Typography.Text>
        <Segmented
          size="small"
          value={pickKind}
          onChange={(v) => setPickKind(v as "izdelie" | "other")}
          options={[
            { value: "izdelie", label: "Изделия" },
            { value: "other", label: "П/ф и прочее" },
          ]}
        />
      </Space>
      {items.length === 0 && !itemsQuery.isLoading ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет позиций" />
      ) : (
        <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
          {lines.map((l, i) => (
            <Space key={i} wrap>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder={pickKind === "izdelie" ? "Изделие: модель или готовый вариант" : "П/ф или прочая позиция"}
                style={{ width: 360 }}
                loading={itemsQuery.isLoading}
                value={l.item_id ?? undefined}
                options={optionsFor(l.item_id)}
                onChange={(v) => {
                  const picked = items.find((x) => x.id === v);
                  if (picked?.is_model) setPicking({ line: i, model: picked });
                  else patch(i, { item_id: v });
                }}
              />
              <InputNumber min={1} placeholder="шт" style={{ width: 80 }} value={l.quantity} onChange={(v) => patch(i, { quantity: v })} />
              {withInvoice && (
                <Input placeholder="счёт 1С" style={{ width: 110 }} value={l.invoice_no} onChange={(e) => patch(i, { invoice_no: e.target.value })} />
              )}
              <Input placeholder="примечание" style={{ width: 140 }} value={l.note} onChange={(e) => patch(i, { note: e.target.value })} />
              {lines.length > 1 && (
                <Button size="small" danger onClick={() => onChange(lines.filter((_, j) => j !== i))}>
                  Убрать
                </Button>
              )}
            </Space>
          ))}
          <Space wrap>
            <Button onClick={() => onChange([...lines, emptyLine()])}>+ позиция</Button>
            {creatableTypes.length > 0 && (
              <Select
                style={{ width: 300 }}
                placeholder="Нет в списке — новая позиция по типу…"
                value={null}
                options={creatableTypes.map((t) => ({ value: t.id, label: `Новая: ${t.name}` }))}
                onChange={(id) => setNewOfType(creatableTypes.find((t) => t.id === id) ?? null)}
              />
            )}
          </Space>
        </Space>
      )}
      {newOfType && (
        <CheckModal
          type={newOfType}
          mode="create"
          areaName={(code) => (areasQuery.data ?? []).find((a) => a.code === code)?.name ?? code ?? "—"}
          onClose={() => setNewOfType(null)}
          onCreated={(itemId) => {
            const empty = lines.findIndex((l) => !l.item_id);
            if (empty >= 0) patch(empty, { item_id: itemId });
            else onChange([...lines, { ...emptyLine(), item_id: itemId }]);
          }}
        />
      )}
      {picking && (
        <VariantPicker
          modelId={picking.model.id}
          modelName={picking.model.name}
          typeId={picking.model.type_id as number}
          onClose={() => setPicking(null)}
          onPicked={(itemId) => {
            patch(picking.line, { item_id: itemId });
            setPicking(null);
          }}
        />
      )}
    </>
  );
}
