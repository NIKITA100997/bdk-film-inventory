import { useMemo, useState } from "react";
import { Select, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listMaterialSkus } from "../api/dictionaries";
import { type MaterialSku } from "../api/units";

interface Props {
  onSelect: (sku: MaterialSku) => void;
  placeholder?: string;
}

export default function ExistingSkuPicker({ onSelect, placeholder }: Props) {
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  const [value, setValue] = useState<number>();

  const groupedOptions = useMemo(() => {
    const groups = new Map<string, { label: string; options: { value: number; label: string }[] }>();
    for (const s of skusQuery.data ?? []) {
      if (!s.is_active) continue;
      const groupTitle = `${s.material.name}, ${s.color.name}`;
      let g = groups.get(groupTitle);
      if (!g) {
        g = { label: groupTitle, options: [] };
        groups.set(groupTitle, g);
      }
      const th = `${s.thickness.value_mm} мм`;
      const mfg = s.manufacturer.name ? ` · ${s.manufacturer.name}` : "";
      g.options.push({ value: s.id, label: `${groupTitle} (${th}${mfg})` });
    }
    return Array.from(groups.values());
  }, [skusQuery.data]);

  return (
    <div>
      <Typography.Text type="secondary" style={{ display: "block", marginBottom: 4, fontSize: 12.5 }}>
        Сначала проверьте — может, такое сочетание уже есть в номенклатуре
      </Typography.Text>
      <Select
        showSearch
        allowClear
        placeholder={placeholder ?? "Найти уже существующую позицию…"}
        loading={skusQuery.isLoading}
        options={groupedOptions}
        optionFilterProp="label"
        style={{ width: "100%" }}
        value={value}
        onChange={(skuId) => {
          setValue(undefined);
          const sku = skusQuery.data?.find((s) => s.id === skuId);
          if (sku) onSelect(sku);
        }}
      />
    </div>
  );
}
