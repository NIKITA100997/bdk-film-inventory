import { Input, Modal, Typography } from "antd";
import { isAxiosError } from "axios";

/** Отказ сервера «на складе назначения уже хватает» (запрет лишнего перемещения). */
export function homeStockBlockText(e: unknown): string | null {
  if (!isAxiosError(e) || e.response?.status !== 409) return null;
  const d = e.response?.data?.detail;
  return typeof d === "string" && d.includes("уже хватает") ? d : null;
}

/** Окно для руководителя: показать, что лежит на складе назначения, и
 * спросить причину перемещения. null — передумал. */
export function askHomeStockOverride(text: string): Promise<string | null> {
  return new Promise((resolve) => {
    let reason = "";
    Modal.confirm({
      title: "На складе назначения плёнки уже хватает",
      width: 560,
      content: (
        <div style={{ display: "grid", gap: 10 }}>
          <Typography.Text>{text}</Typography.Text>
          <Typography.Text type="secondary">Если всё же нужно переместить (например, штрипсы там бракованные), укажите причину — она попадёт в перемещение.</Typography.Text>
          <Input.TextArea autoFocus rows={2} placeholder="Причина" onChange={(ev) => (reason = ev.target.value)} />
        </div>
      ),
      okText: "Переместить",
      cancelText: "Не перемещать",
      onOk: () => {
        if (!reason.trim()) return Promise.reject(new Error("нужна причина"));
        resolve(reason.trim());
        return undefined;
      },
      onCancel: () => resolve(null),
    });
  });
}

/** Отказ для того, кто обойти не может: полный текст, что и где лежит. */
export function showHomeStockBlock(text: string) {
  Modal.warning({ title: "Перемещать не нужно", content: text, okText: "Понятно", width: 560 });
}
