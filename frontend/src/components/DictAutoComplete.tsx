import { useMemo } from "react";
import { AutoComplete, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listColors, listManufacturers, listMaterials } from "../api/dictionaries";
import { stringSimilarity } from "../utils/similarity";

export type DictKind = "materials" | "colors" | "manufacturers";

const fetchers: Record<DictKind, () => Promise<{ name: string }[]>> = {
  materials: listMaterials,
  colors: listColors,
  manufacturers: listManufacturers,
};

const kindLabels: Record<DictKind, string> = {
  materials: "материал",
  colors: "цвет",
  manufacturers: "производитель",
};

const FUZZY_THRESHOLD = 0.82;

interface Props {
  kind: DictKind;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/** Автокомплит по справочнику (2.1a/5.6 ТЗ) — подсказывает существующие
 * значения по мере ввода, чтобы "Дуб беленый" и "Дуб белёный" не
 * расползались на две позиции. Не блокирует ввод нового значения: если
 * введённое не совпадает ни с чем — явно предлагает "Создать «…»"
 * (9.2 раздел бэклога доработок), а если похоже, но не совпадает точно —
 * предупреждает и предлагает использовать существующее. */
export default function DictAutoComplete({ kind, value, onChange, placeholder, autoFocus }: Props) {
  const query = useQuery({ queryKey: [kind], queryFn: fetchers[kind] });
  const names = useMemo(() => (query.data ?? []).map((e) => e.name), [query.data]);

  const trimmed = (value ?? "").trim();
  const exactMatch = names.some((n) => n.toLowerCase() === trimmed.toLowerCase());

  const closest = useMemo(() => {
    if (!trimmed || exactMatch) return null;
    let best: { name: string; score: number } | null = null;
    for (const n of names) {
      const score = stringSimilarity(trimmed, n);
      if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) best = { name: n, score };
    }
    return best;
  }, [trimmed, exactMatch, names]);

  const options: { value: string; label: React.ReactNode }[] = names
    .filter((n) => n.toLowerCase().includes(trimmed.toLowerCase()))
    .map((n) => ({ value: n, label: n }));

  if (trimmed && !exactMatch) {
    options.push({
      value: trimmed,
      label: <span style={{ color: "#1677ff" }}>Создать «{trimmed}»</span>,
    });
  }

  return (
    <div>
      <AutoComplete
        options={options}
        value={value}
        onChange={onChange}
        filterOption={false}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {closest && (
        <Typography.Text type="warning" style={{ fontSize: 12, display: "block", marginTop: 2 }}>
          Похоже на «{closest.name}» — это тот же {kindLabels[kind]}?{" "}
          <a onClick={() => onChange?.(closest.name)}>Использовать</a>
        </Typography.Text>
      )}
    </div>
  );
}
