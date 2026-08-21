import { useQuery } from "@tanstack/react-query";
import { Select } from "antd";
import { listEmployees } from "../api/dictionaries";

interface Props {
  value?: string;
  onChange?: (value: string) => void;
  id?: string;
  placeholder?: string;
}

/** Сотрудники цеха (раздел про автокомплит) — employee_names остаётся
 * одной строкой с несколькими именами через запятую ("Иванов, Петров"),
 * поэтому не переиспользует DictAutoComplete напрямую (тот заменяет всё
 * значение поля целиком, годится для одного значения — материал/цвет/
 * толщина/производитель, но не для нескольких имён сразу). antd
 * Select mode="tags" — тегами выбираются/добавляются отдельные имена,
 * join через ", " при сохранении; справочник employees только
 * подсказывает уже вводившиеся варианты, не блокирует новые. */
export default function EmployeesTagSelect({ value, onChange, id, placeholder }: Props) {
  const employeesQuery = useQuery({ queryKey: ["dict-autocomplete", "employees"], queryFn: listEmployees });
  const options = (employeesQuery.data ?? []).map((e) => ({ value: e.name, label: e.name }));

  const tags = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <Select
      id={id}
      mode="tags"
      options={options}
      value={tags}
      onChange={(v) => onChange?.(v.join(", "))}
      placeholder={placeholder}
      filterOption={(input, option) => (option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
    />
  );
}
