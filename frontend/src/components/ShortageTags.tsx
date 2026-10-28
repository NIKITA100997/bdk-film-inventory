import { Space, Tag } from "antd";

const fmt = (v: number) => v.toLocaleString("ru-RU", { maximumFractionDigits: 2 });

/** Нехватка по приоритетам (28.10): «под задания» — срочно, красным;
 * «до мин. остатка» — пополнение, не горит. Одна строка — обе части. */
export default function ShortageTags({
  total,
  tasks,
  min,
  unit,
  okText = "хватает",
}: {
  total: number;
  tasks?: number;
  min?: number;
  unit?: string;
  okText?: string;
}) {
  if (!(total > 0.001)) return <Tag color="green">{okText}</Tag>;
  const u = unit ? ` ${unit}` : "";
  // старый ответ сервера без разбивки — одним числом
  if (tasks == null && min == null) return <Tag color="red">{fmt(total) + u}</Tag>;
  return (
    <Space size={4} wrap>
      {(tasks ?? 0) > 0.001 && (
        <Tag color="red" title="не хватает под открытые задания — срочно">
          под задания {fmt(tasks!)}
          {u}
        </Tag>
      )}
      {(min ?? 0) > 0.001 && (
        <Tag color="blue" title="пополнить до минимального остатка — не срочно">
          до мин. остатка {fmt(min!)}
          {u}
        </Tag>
      )}
    </Space>
  );
}
