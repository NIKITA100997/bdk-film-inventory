/** Подпись варианта свойства: служебные значения (на них завязаны условия
 * правил типа — `кромка == "aluminum"`) показываем по-русски. */
const LABELS: Record<string, string> = { abs: "ABS", aluminum: "алюминий" };

export const optionLabel = (value: string | null | undefined): string => (value ? (LABELS[value] ?? value) : "—");
