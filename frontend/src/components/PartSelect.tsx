import { useState } from "react";
import { Segmented, Select, Space, type SelectProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listParts, type Part } from "../api/dictionaries";

type FilmFilter = "bare" | "laminated" | "all";

interface Props {
  onSelect: (part: Part) => void;
  placeholder?: string;
  /** Участок (задания, строки BOM…) — список сужается по маршруту, как
   * в ERP по рабочему центру: только детали, у которых в маршруте есть
   * операция на этом участке (заготовку на окутку не предложит — её не
   * окутывают), плюс детали без маршрута (ещё не настроены) и с явной
   * привязкой к участку. Без этого пропа — весь справочник. */
  area?: string;
  /** Переключатель «Без плёнки / В плёнке / Все» над списком (03.10) —
   * при оприходовании партии мастер п/ф не должен по ошибке поставить на
   * учёт деталь в плёнке вместо детали без плёнки. По умолчанию — без плёнки. */
  filmFilter?: boolean;
}

const isLaminated = (p: Part) => p.stage === "laminated";

/** Справочник деталей (раздел про выбор детали в задание) — не поле формы
 * само по себе (нет value/onChange), а подсказчик: выбор подставляет
 * несколько полей формы-потребителя (название/ширина/длина/ширина
 * штрипса), дальше их можно править руками — тот же приём, что уже есть
 * у выбора позиции материала (sku_id → applySkuFields в CreateTaskModal.tsx).
 * Значение самого Select сразу сбрасывается после выбора — не залипает на
 * одной детали, следующий раз можно выбрать другую или ввести вручную.
 * Детали в плёнке — отдельной группой списка. */
export default function PartSelect({ onSelect, placeholder, area, filmFilter }: Props) {
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const [value, setValue] = useState<number>();
  const [film, setFilm] = useState<FilmFilter>("bare");

  const visibleParts = (partsQuery.data ?? [])
    .filter((p) => !area || p.area === area || p.stages.length === 0 || p.stages.some((s) => s.area === area))
    .filter((p) => !filmFilter || film === "all" || (film === "laminated") === isLaminated(p));
  const toOption = (p: Part) => ({
    value: p.id,
    label: `${p.name} — ${p.width_mm}×${p.length_m}${p.strip_width_mm ? `, штрипс ${p.strip_width_mm}` : ""}`,
  });
  const bare = visibleParts.filter((p) => !isLaminated(p));
  const laminated = visibleParts.filter(isLaminated);
  const options: SelectProps["options"] =
    bare.length && laminated.length
      ? [
          { label: "Без плёнки и заготовки", options: bare.map(toOption) },
          { label: "В плёнке", options: laminated.map(toOption) },
        ]
      : visibleParts.map(toOption);

  const select = (
    <Select
      showSearch
      allowClear
      placeholder={placeholder ?? "Деталь из справочника (опционально)"}
      options={options}
      optionFilterProp="label"
      value={value}
      style={filmFilter ? { width: "100%" } : undefined}
      onChange={(partId) => {
        setValue(undefined);
        const part = partsQuery.data?.find((p) => p.id === partId);
        if (part) onSelect(part);
      }}
    />
  );
  if (!filmFilter) return select;
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      <Segmented<FilmFilter>
        size="small"
        value={film}
        onChange={setFilm}
        options={[
          { value: "bare", label: "Без плёнки" },
          { value: "laminated", label: "В плёнке" },
          { value: "all", label: "Все" },
        ]}
      />
      {select}
    </Space>
  );
}
