import { Form, Select } from "antd";
import type { Part } from "../api/dictionaries";
import { registrationStageOptions } from "../utils/registrationStages";

/** Поле «Этап» формы регистрации партии (name="stage_id"). */
export default function RegistrationStageField({ part }: { part: Part }) {
  if (part.stages.length < 2) return null;
  const options = registrationStageOptions(part);
  return (
    <Form.Item
      name="stage_id"
      label="На каком этапе партия"
      extra="Уже сделанную партию ставьте на этап после сделанной операции — например, отфрезерованную стоевую на «Окутку». Не выбрано — первый этап."
    >
      <Select allowClear placeholder={options[0].label} options={options} />
    </Form.Item>
  );
}
