import { useState } from "react";
import { Select, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listMaterialSkus } from "../api/dictionaries";
import { skuLabel, type MaterialSku } from "../api/units";

interface Props {
  onSelect: (sku: MaterialSku) => void;
  placeholder?: string;
}

/** Раздел про подсказку существующих сочетаний плёнки — 4 отдельных поля
 * DictAutoComplete (материал/цвет/толщина/производитель) не знают друг о
 * друге, поэтому опечатка или чуть другая формулировка в одном из них
 * тихо заводит новую позицию номенклатуры вместо использования уже
 * существующей ("ПЭТ Светло-серый" и "ПЭТ Светло-серый (gray silk)" — по
 * факту одно и то же). Этот подсказчик — не поле формы (нет своего
 * состояния снаружи), а быстрый способ найти уже существующее сочетание
 * целиком и подставить все 4 поля сразу; тот же приём и источник данных
 * (listMaterialSkus/skuLabel), что уже даёт выбор позиции в
 * CreateTaskModal.tsx/Issue.tsx — просто здесь это отдельный переиспользуемый
 * компонент, а не инлайн-Select. Значение сбрасывается сразу после выбора
 * (как PartSelect) — дальше человек продолжает с уже подставленными полями,
 * которые остаются редактируемыми, ничего не блокируется. */
export default function ExistingSkuPicker({ onSelect, placeholder }: Props) {
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  const [value, setValue] = useState<number>();

  const options = (skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }));

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
        options={options}
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
