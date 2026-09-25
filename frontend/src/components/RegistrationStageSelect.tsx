import { Form, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import type { Part } from "../api/dictionaries";
import { listAreas } from "../api/areas";

/** Поле «На каком этапе партия» формы регистрации (name="stage_id"): этап
 * подписан своим участком — партия числится там. Отфрезерованная, но не
 * переданная на окутку, — «Фрезеровка» (участок производства п/ф);
 * переданная — «Окутка». Не выбрано — первый этап. */
export default function RegistrationStageField({ part }: { part: Part }) {
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  if (part.stages.length < 2) return null;
  const areaName = (code: string | null) =>
    code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "без участка (на хранении)";
  const options = [...part.stages]
    .sort((a, b) => a.sequence_order - b.sequence_order)
    .map((s) => ({ value: s.id, label: `${s.name} — ${areaName(s.area)}` }));
  return (
    <Form.Item
      name="stage_id"
      label="На каком этапе партия"
      extra="Партия будет числиться на участке этапа. Отфрезерованная, но не переданная на окутку, — «Фрезеровка»; на окутку её потом переводит «Перевести на следующий этап». Не выбрано — первый этап."
    >
      <Select allowClear placeholder={options[0].label} options={options} />
    </Form.Item>
  );
}
