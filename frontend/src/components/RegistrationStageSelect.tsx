import { Form, Radio, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import type { Part } from "../api/dictionaries";
import { listAreas } from "../api/areas";
import { registrationStageOptions } from "../utils/registrationStages";

/** Поля формы регистрации партии: «На каком этапе партия» (stage_id) и,
 * если у этапа есть участок, — «Где партия сейчас» (issue_to_area): уже
 * на участке этапа или сделана, но ещё не передана (отфрезерована, лежит
 * на участке п/ф — окутка её пока не получила). */
export default function RegistrationStageField({ part }: { part: Part }) {
  const form = Form.useFormInstance();
  const stageId = Form.useWatch("stage_id", form) as number | undefined;
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const stages = [...part.stages].sort((a, b) => a.sequence_order - b.sequence_order);
  const stage = stages.find((s) => s.id === stageId) ?? stages[0];
  const areaName = stage?.area ? (areasQuery.data?.find((a) => a.code === stage.area)?.name ?? stage.area) : null;
  const options = registrationStageOptions(part);
  return (
    <>
      {stages.length > 1 && (
        <Form.Item
          name="stage_id"
          label="На каком этапе партия"
          extra="Уже сделанную партию ставьте на этап после сделанной операции — например, отфрезерованную стоевую на «Окутку». Не выбрано — первый этап."
        >
          <Select allowClear placeholder={options[0].label} options={options} />
        </Form.Item>
      )}
      {areaName && (
        <Form.Item name="issue_to_area" label="Где партия сейчас" initialValue={true}>
          <Radio.Group
            options={[
              { value: true, label: `Уже на участке «${areaName}»` },
              { value: false, label: "Ещё не передана — на хранении" },
            ]}
          />
        </Form.Item>
      )}
    </>
  );
}
