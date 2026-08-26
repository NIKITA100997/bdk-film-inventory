import { useState } from "react";
import { Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listParts, type Part } from "../api/dictionaries";

interface Props {
  onSelect: (part: Part) => void;
  placeholder?: string;
  /** Раздел про привязку деталей к участку — сужает список до деталей
   * этого участка плюс общих (area: null). Без этого пропа — весь
   * справочник, как раньше (напр. форма ещё не выбрала участок). */
  area?: string;
}

/** Справочник деталей (раздел про выбор детали в задание) — не поле формы
 * само по себе (нет value/onChange), а подсказчик: выбор подставляет
 * несколько полей формы-потребителя (название/ширина/длина/ширина
 * штрипса), дальше их можно править руками — тот же приём, что уже есть
 * у выбора позиции материала (sku_id → applySkuFields в CreateTaskModal.tsx).
 * Значение самого Select сразу сбрасывается после выбора — не залипает на
 * одной детали, следующий раз можно выбрать другую или ввести вручную. */
export default function PartSelect({ onSelect, placeholder, area }: Props) {
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const [value, setValue] = useState<number>();

  const visibleParts = (partsQuery.data ?? []).filter((p) => !area || !p.area || p.area === area);
  const options = visibleParts.map((p) => ({
    value: p.id,
    label: `${p.name} — ${p.width_mm}×${p.length_m}${p.strip_width_mm ? `, штрипс ${p.strip_width_mm}` : ""}`,
  }));

  return (
    <Select
      showSearch
      allowClear
      placeholder={placeholder ?? "Деталь из справочника (опционально)"}
      options={options}
      optionFilterProp="label"
      value={value}
      onChange={(partId) => {
        setValue(undefined);
        const part = partsQuery.data?.find((p) => p.id === partId);
        if (part) onSelect(part);
      }}
    />
  );
}
