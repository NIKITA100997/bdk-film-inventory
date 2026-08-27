import { useState } from "react";
import { Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listWarehouses } from "../api/storage";

// Раздел про отчёты/остатки по складам отдельно — выбор склада показываем
// только если складов больше одного (тот же принцип, что уже в Receive.tsx
// для поля "Склад" при приёмке), иначе лишний фильтр без смысла. Общий хук
// — переиспользуется в Reports.tsx, MaterialsExplorer.tsx, UnitCard.tsx.
export function useWarehouseFilter() {
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });
  const activeWarehouses = (warehousesQuery.data ?? []).filter((w) => w.is_active);
  const [warehouseId, setWarehouseId] = useState<number>();
  const picker =
    activeWarehouses.length > 1 ? (
      <Select
        allowClear
        placeholder="Склад"
        style={{ width: 200 }}
        options={activeWarehouses.map((w) => ({ value: w.id, label: w.name }))}
        value={warehouseId}
        onChange={setWarehouseId}
      />
    ) : null;
  return { warehouseId, picker };
}
