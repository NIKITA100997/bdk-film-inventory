import { isAxiosError } from "axios";

/** Текст ошибки запроса для сообщения пользователю — один на всё приложение.
 * Сервер отвечает detail строкой («Участок не найден») или списком ошибок
 * полей (проверка запроса) — показываем первые; нет ответа — нет связи. */
export function apiErrorMessage(e: unknown, fallback: string): string {
  // отчёт не отправлен по ответу «Нет» на вопрос сервера (utils/reportConfirm)
  if (e instanceof Error && e.name === "ReportCancelled") return e.message;
  if (isAxiosError(e)) {
    const detail = e.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && typeof detail.message === "string") return detail.message;
    if (Array.isArray(detail) && detail.length) {
      const msgs = detail
        .map((d: { msg?: string; loc?: (string | number)[] }) => {
          const field = d.loc?.filter((x) => x !== "body").join(".");
          return d.msg ? (field ? `${field}: ${d.msg}` : d.msg) : null;
        })
        .filter(Boolean);
      if (msgs.length) return `${fallback}: ${msgs.slice(0, 3).join("; ")}`;
    }
    if (!e.response) return `${fallback}: нет связи с сервером`;
  }
  return fallback;
}
