import { Select } from "antd";
import { useQueries, useQuery } from "@tanstack/react-query";
import { listRacks, listMacroZoneRules, getRackOccupancy, type MacroZoneRule } from "../api/storage";
import type { MaterialSku } from "../api/units";

function ruleMatchesSku(rule: MacroZoneRule, sku: MaterialSku): boolean {
  return (
    (rule.material_id === null || rule.material_id === sku.material.id) &&
    (rule.color_id === null || rule.color_id === sku.color.id) &&
    (rule.thickness_id === null || rule.thickness_id === sku.thickness.id) &&
    (rule.manufacturer_id === null || rule.manufacturer_id === sku.manufacturer.id)
  );
}

function shelfCompatible(shelf: number, rules: MacroZoneRule[], sku: MaterialSku): boolean {
  const applicable = rules.filter((r) => r.from_shelf <= shelf && shelf <= r.to_shelf);
  // Полка без единого правила — открытая зона, подходит любой плёнке (тот
  // же принцип, что и на бэкенде, services/placement.py::rules_for_location).
  if (applicable.length === 0) return true;
  return applicable.some((r) => ruleMatchesSku(r, sku));
}

interface Props {
  value?: string;
  onChange?: (value: string) => void;
  // Раздел про адрес не текстом, а выбором из существующих — без sku
  // показываем все полки без фильтра по зонированию (например, когда
  // компонент используется вне контекста конкретной единицы плёнки).
  sku?: MaterialSku;
  warehouseId?: number;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}

/** Выбор адреса ячейки из реально существующих полок (раздел про
 * перемещение/размещение — раньше адрес вводился текстом, опечатка вроде
 * "Р-3-007" вместо "Р-3-07" не блокировалась ни на фронте, ни на бэкенде,
 * т.к. правило зонирования просто не находится для несуществующего кода
 * и подходит любой плёнке). Список — реальные полки реальных стеллажей
 * (`GET /racks/{id}/occupancy`, тот же источник, что уже красит занятость
 * на StorageMap.tsx), с занятостью прямо в подписи; если передан sku —
 * полки, закрытые правилом зонирования за другой плёнкой, не показываются
 * вовсе (та же проверка, что бэкенд всё равно сделает при сохранении —
 * здесь просто не даём выбрать заведомо отклоняемый вариант). */
export default function LocationSelect({ value, onChange, sku, warehouseId, disabled, placeholder, autoFocus }: Props) {
  const racksQuery = useQuery({ queryKey: ["racks", warehouseId], queryFn: () => listRacks(warehouseId) });
  const activeRacks = (racksQuery.data ?? []).filter((r) => r.is_active);

  const occupancyByRack = useQueries({
    queries: activeRacks.map((r) => ({ queryKey: ["rack-occupancy", r.id], queryFn: () => getRackOccupancy(r.id) })),
  });
  const rulesByRack = useQueries({
    queries: activeRacks.map((r) => ({ queryKey: ["macro-zone-rules", r.id], queryFn: () => listMacroZoneRules(r.id) })),
  });

  const options = activeRacks.map((rack, i) => {
    const cells = occupancyByRack[i]?.data ?? [];
    const rules = rulesByRack[i]?.data ?? [];
    return {
      label: `${rack.code} (${rack.type === "strip" ? "штрипсовый" : "рулонный"})`,
      options: cells
        .filter((c) => !sku || shelfCompatible(c.shelf, rules, sku))
        .map((c) => ({
          value: c.location_code,
          label: `${c.location_code} — ${c.units.length > 0 ? `занято ${c.units.length} из ${c.capacity}` : "свободно"}`,
        })),
    };
  });

  const loading = racksQuery.isLoading || occupancyByRack.some((q) => q.isLoading) || rulesByRack.some((q) => q.isLoading);

  return (
    <Select
      showSearch
      allowClear
      autoFocus={autoFocus}
      disabled={disabled}
      loading={loading}
      placeholder={placeholder ?? "Выберите адрес"}
      value={value}
      onChange={onChange}
      options={options}
      optionFilterProp="label"
      notFoundContent={sku ? "Нет подходящих по правилам зонирования полок" : "Полок нет — заведите стеллаж в администрировании"}
      style={{ width: "100%" }}
    />
  );
}
