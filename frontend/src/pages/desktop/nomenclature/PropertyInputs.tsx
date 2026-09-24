import { Checkbox, Form, Input, InputNumber, Select } from "antd";
import type { ItemType, PropertyValue } from "../../../api/itemTypes";

/** Поля ввода значений свойств типа — в карточке позиции, в проверке правил
 * и при создании позиции по типу. */
export default function PropertyInputs({
  type,
  values,
  onChange,
}: {
  type: ItemType;
  values: Record<string, PropertyValue>;
  onChange: (next: Record<string, PropertyValue>) => void;
}) {
  return (
    <>
      {type.properties.map((p) => {
        const key = String(p.id);
        const v = values[key];
        const set = (nv: PropertyValue) => onChange({ ...values, [key]: nv });
        return (
          <Form.Item key={p.id} label={`${p.name}${p.unit ? `, ${p.unit}` : ""}`} required={p.is_required} style={{ marginBottom: 12 }}>
            {p.value_type === "number" && (
              <InputNumber value={(v as number | null) ?? null} style={{ width: 200 }} onChange={(nv) => set(nv)} />
            )}
            {p.value_type === "text" && <Input value={(v as string | null) ?? ""} onChange={(e) => set(e.target.value)} />}
            {p.value_type === "bool" && <Checkbox checked={!!v} onChange={(e) => set(e.target.checked)} />}
            {p.value_type === "list" && (
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 260 }}
                value={(v as number | null) ?? undefined}
                onChange={(nv) => set(nv ?? null)}
                options={p.options.filter((o) => o.is_active || o.id === v).map((o) => ({ value: o.id, label: o.value }))}
              />
            )}
          </Form.Item>
        );
      })}
    </>
  );
}
