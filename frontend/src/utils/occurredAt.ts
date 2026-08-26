import dayjs, { type Dayjs } from "dayjs";

/** Раздел про дату операции задним числом — выбранный день комбинируется
 * с текущим временем суток (не полночь), чтобы несколько операций,
 * внесённых сегодня одна за другой за один и тот же прошлый день,
 * сохраняли между собой правильный порядок в журнале. Пусто/не выбрано —
 * undefined, поле не уходит в payload, бэкенд использует "сейчас" как и
 * раньше. */
export function toOccurredAtIso(picked: Dayjs | null | undefined): string | undefined {
  if (!picked) return undefined;
  const now = dayjs();
  return picked
    .hour(now.hour())
    .minute(now.minute())
    .second(now.second())
    .millisecond(now.millisecond())
    .toISOString();
}
