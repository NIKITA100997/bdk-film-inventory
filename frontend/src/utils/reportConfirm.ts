import { Modal } from "antd";
import { isAxiosError } from "axios";

/** Отчёт не отправлен — человек ответил «Нет» на вопрос сервера. */
export class ReportCancelled extends Error {
  constructor(question: string) {
    super(`Не сохранено: ${question}`);
    this.name = "ReportCancelled";
  }
}

/** Вопрос сервера (19.10): сверх плана больше чем на 10 % или повтор того же
 * отчёта за 2 минуты — 409 с { confirm, message }. */
export function confirmQuestion(e: unknown): string | null {
  if (!isAxiosError(e) || e.response?.status !== 409) return null;
  const d = e.response.data?.detail;
  return d && typeof d === "object" && typeof d.message === "string" ? d.message : null;
}

// Вопросы по одному: при сохранении нескольких строк сразу окна не
// наслаиваются друг на друга.
let queue: Promise<unknown> = Promise.resolve();
function ask(question: string): Promise<boolean> {
  const next = queue.then(
    () =>
      new Promise<boolean>((resolve) =>
        Modal.confirm({
          title: "Проверьте отчёт",
          content: question,
          okText: "Да, сохранить",
          cancelText: "Нет",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      ),
  );
  queue = next.catch(() => undefined);
  return next;
}

/** Отправить отчёт; если сервер переспросил — спросить человека и при «Да»
 * отправить ещё раз с подтверждением. */
export async function sendReportWithConfirm<T>(send: (confirmed: boolean) => Promise<T>): Promise<T> {
  try {
    return await send(false);
  } catch (e) {
    const q = confirmQuestion(e);
    if (!q) throw e;
    if (!(await ask(q))) throw new ReportCancelled(q);
    return await send(true);
  }
}
