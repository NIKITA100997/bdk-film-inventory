/** Вид операции маршрута (03.10) — признак, по которому работает логика,
 * а не название операции (см. backend services/operation_roles.py). */
export type OperationRole = "film" | "program" | null;

export const OPERATION_ROLE_LABEL: Record<"film" | "program", string> = {
  film: "с плёнкой",
  program: "программа станка",
};

export const OPERATION_ROLE_OPTIONS = [
  { value: "film", label: "с плёнкой" },
  { value: "program", label: "программа станка" },
];

export const OPERATION_ROLE_HINT =
  "Вид операции: «с плёнкой» — строка задания несёт плёнку, склад выдаёт штрипс или рулон, отчёт списывает метры " +
  "(ламинация, окутка); «программа станка» — при запуске проверяется программа и нестандартный размер (фрезеровка).";
