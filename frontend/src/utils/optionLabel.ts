/** Подпись варианта свойства: своя подпись варианта (настраивается в
 * «Варианты» свойства), иначе значение. Значение бывает служебным — на него
 * завязаны условия правил типа (`кромка == "aluminum"`). */
export const optionLabel = (opt: { value: string; label?: string | null } | null | undefined): string =>
  opt ? opt.label || opt.value : "—";
