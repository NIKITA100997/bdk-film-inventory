import { Select, Typography } from "antd";
import type { PfDemandRow } from "../api/pfDemand";

/** Где ламинировать панель в этом задании: прессы (по маршруту) или окутка
 * на Фабрике (крупная партия — от factory_min_pieces панелей). */
export default function LaminationAreaSelect({
  row,
  value,
  onChange,
  areaName,
  disabled,
}: {
  row: PfDemandRow;
  value: string | undefined;
  onChange: (v: string) => void;
  areaName: (code: string | null) => string | null;
  disabled?: boolean;
}) {
  if (!row.lamination_area || !row.factory_area) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Select
      size="small"
      style={{ width: 230 }}
      disabled={disabled}
      value={value}
      onChange={onChange}
      options={[
        { value: row.lamination_area, label: areaName(row.lamination_area) ?? row.lamination_area },
        { value: row.factory_area, label: `Фабрика — окутка (от ${row.factory_min_pieces} шт)` },
      ]}
    />
  );
}
