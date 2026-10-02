import { Space, Tag, Typography } from "antd";

/** Характеристика позиции (серия, ширина, цвет, кромка…) — с сервера,
 * services/type_rules.item_chars. */
export interface ItemChar {
  code: string;
  name: string;
  value: string;
}

const num = (v: string | undefined) => (v ? v.replace(/\s*мм$/, "") : "");

/** Изделие по характеристикам вместо длинного названия: серия и размер
 * крупно, цвет и признаки (молдинг, стекло, замок, кромка) — метками.
 * Без характеристик (п/ф, позиция без типа) — просто название. */
export function ItemChars({
  chars,
  name,
  showName = true,
  strong = true,
}: {
  chars?: ItemChar[] | null;
  name?: string | null;
  // мелко под метками — полное название (для поиска глазами и сверки с 1С)
  showName?: boolean;
  strong?: boolean;
}) {
  if (!chars || chars.length === 0) return strong ? <Typography.Text strong>{name ?? "—"}</Typography.Text> : <span>{name ?? "—"}</span>;
  const by = Object.fromEntries(chars.map((c) => [c.code, c]));
  const used = new Set(["серия", "ширина", "высота", "цвет", "кромка", "цвет_кромки", "стекло"]);
  const size = by["ширина"] && by["высота"] ? `${num(by["ширина"].value)}×${num(by["высота"].value)}` : "";
  const head = [by["серия"]?.value, size].filter(Boolean).join(" ");
  const edge = [by["кромка"] ? `кромка ${by["кромка"].value}` : "", by["цвет_кромки"]?.value ?? ""].filter(Boolean).join(" · ");
  const flags = chars.filter((c) => !used.has(c.code));
  return (
    <Space direction="vertical" size={2}>
      <Space size={[6, 4]} wrap>
        {head && (strong ? <Typography.Text strong>{head}</Typography.Text> : <span>{head}</span>)}
        {by["цвет"] && (
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            {by["цвет"].value}
          </Tag>
        )}
        {flags.map((c) => (
          <Tag key={c.code} style={{ marginInlineEnd: 0 }}>
            {c.value === "да" ? c.name.toLowerCase() : `${c.name}: ${c.value}`}
          </Tag>
        ))}
        {by["стекло"] && (
          <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
            стекло {by["стекло"].value}
          </Tag>
        )}
        {edge && (
          <Tag color="default" style={{ marginInlineEnd: 0 }}>
            {edge}
          </Tag>
        )}
      </Space>
      {showName && name && (
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {name}
        </Typography.Text>
      )}
    </Space>
  );
}
