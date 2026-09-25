import { useQuery } from "@tanstack/react-query";
import type { Part } from "../api/dictionaries";
import { getRegistrationStages } from "../api/partUnits";

/** Этапы в подписях: на каком этапе партия и что с ней уже сделано. Партия
 * «на этапе X» ждёт операции X; уже сделанную ставят на следующий этап —
 * отфрезерованную стоевую на «Окутку». */
export function registrationStageOptions(part: Part) {
  const stages = [...part.stages].sort((a, b) => a.sequence_order - b.sequence_order);
  return stages.map((s, i) => ({
    value: s.id,
    label: i === 0 ? `${s.name} — ещё не начата` : `${s.name} — «${stages[i - 1].name}» уже сделана`,
  }));
}

/** Этап по умолчанию при регистрации: у детали из заготовки — после её
 * операции (вручную её ставят на учёт уже сделанной), иначе — первый. */
export function useRegistrationDefaults() {
  const q = useQuery({ queryKey: ["part-unit-registration-stages"], queryFn: getRegistrationStages });
  return (part: Part): number | undefined => q.data?.[part.id];
}
