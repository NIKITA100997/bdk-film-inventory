import { Checkbox, InputNumber, Space, Tag, Typography } from "antd";

// Раздел про общий штрипс на детали одного задания — единый список
// рулонов (свои + заимствованные с соседних строк той же ширины,
// borrowable_units) с отметкой галочкой вместо повторяющихся выпадающих
// списков ("Рулон" + "+ ещё рулон" по одному разу на каждый рулон).
// Раньше в ReportModal.tsx/MasterQuickReportPanel.tsx было два раздельных
// контрола на одно и то же множество единиц — здесь один список, общий
// для обоих мест.

export interface RollPickerOption {
  value: number;
  widthMm: number;
  remainingM: number;
  own: boolean;
  fromPartName?: string | null;
}

export interface RollPickerExtra {
  materialUnitId: number;
  remainingM: number;
}

/** Первый отмеченный рулон становится основным (value/onChange — та же
 * пара, что и у обычного управляемого поля формы, чтобы использовать
 * как дочерний элемент Form.Item без обвязки); остальные отмеченные —
 * дополнительные (extraRolls), каждый со своим полем "остаток сейчас" —
 * та же механика, что раньше была в отдельном списке Tag. Единица не
 * может быть основной и дополнительной одновременно — по построению
 * setChecked ниже: снятие галочки с основного повышает первый
 * дополнительный до основного, а не просто обнуляет выбор, если в
 * списке дополнительных ещё что-то отмечено. */
export default function RollPicker({
  options,
  value,
  onChange,
  extraRolls,
  onExtraRollsChange,
}: {
  options: RollPickerOption[];
  value?: number | null;
  onChange?: (value: number | null) => void;
  extraRolls: RollPickerExtra[];
  onExtraRollsChange: (rolls: RollPickerExtra[]) => void;
}) {
  const setChecked = (optValue: number, checked: boolean) => {
    if (checked) {
      if (value == null) {
        onChange?.(optValue);
      } else {
        const opt = options.find((o) => o.value === optValue);
        onExtraRollsChange([...extraRolls, { materialUnitId: optValue, remainingM: opt?.remainingM ?? 0 }]);
      }
      return;
    }
    if (optValue === value) {
      if (extraRolls.length > 0) {
        const [first, ...rest] = extraRolls;
        onChange?.(first.materialUnitId);
        onExtraRollsChange(rest);
      } else {
        onChange?.(null);
      }
    } else {
      onExtraRollsChange(extraRolls.filter((e) => e.materialUnitId !== optValue));
    }
  };

  if (options.length === 0) {
    return <Typography.Text type="secondary">Сначала выдайте рулон этой строке на «Выдаче участку»</Typography.Text>;
  }

  return (
    <Space direction="vertical" size={4} style={{ width: "100%" }}>
      {options.map((o) => {
        const extra = extraRolls.find((e) => e.materialUnitId === o.value);
        const isPrimary = o.value === value;
        const checked = isPrimary || !!extra;
        return (
          <Space key={o.value} align="start" wrap>
            <Checkbox checked={checked} onChange={(e) => setChecked(o.value, e.target.checked)}>
              №{o.value} — {o.widthMm} мм, остаток {o.remainingM} м{" "}
              {o.own ? <Tag color="green">своя</Tag> : <Tag color="blue">с детали «{o.fromPartName ?? "?"}»</Tag>}
              {isPrimary && <Tag>основной</Tag>}
            </Checkbox>
            {extra && (
              <InputNumber
                size="small"
                min={0}
                step={0.1}
                addonBefore="остаток сейчас"
                addonAfter="м"
                style={{ width: 190 }}
                value={extra.remainingM}
                onChange={(v) =>
                  onExtraRollsChange(extraRolls.map((e) => (e.materialUnitId === o.value ? { ...e, remainingM: v ?? 0 } : e)))
                }
              />
            )}
          </Space>
        );
      })}
    </Space>
  );
}
