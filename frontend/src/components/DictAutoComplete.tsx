import { AutoComplete } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listColors, listManufacturers, listMaterials } from "../api/dictionaries";

export type DictKind = "materials" | "colors" | "manufacturers";

const fetchers: Record<DictKind, () => Promise<{ name: string }[]>> = {
  materials: listMaterials,
  colors: listColors,
  manufacturers: listManufacturers,
};

interface Props {
  kind: DictKind;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/** Автокомплит по справочнику (2.1a/5.6 ТЗ) — подсказывает существующие
 * значения по мере ввода, чтобы "Дуб беленый" и "Дуб белёный" не
 * расползались на две позиции. Не блокирует ввод нового значения — просто
 * помогает не изобретать дубликат случайно. */
export default function DictAutoComplete({ kind, value, onChange, placeholder, autoFocus }: Props) {
  const query = useQuery({ queryKey: [kind], queryFn: fetchers[kind] });
  const options = (query.data ?? []).map((e) => ({ value: e.name }));

  return (
    <AutoComplete
      options={options}
      value={value}
      onChange={onChange}
      filterOption={(inputValue, option) =>
        !!option?.value && String(option.value).toLowerCase().includes(inputValue.toLowerCase())
      }
      placeholder={placeholder}
      autoFocus={autoFocus}
    />
  );
}
