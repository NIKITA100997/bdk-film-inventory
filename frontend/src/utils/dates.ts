import dayjs from "dayjs";

/** Единый вид дат во всём приложении: 05.10.2026 и 05.10.2026 14:23. */
export const fmtDate = (v: string | number | Date | null | undefined): string => (v ? dayjs(v).format("DD.MM.YYYY") : "—");

export const fmtDateTime = (v: string | number | Date | null | undefined): string =>
  v ? dayjs(v).format("DD.MM.YYYY HH:mm") : "—";
