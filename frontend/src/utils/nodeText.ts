import { isValidElement, type ReactNode } from "react";

/** Текст того, что ячейка показывает на экране, — для выгрузки в Excel и
 * печати любой таблицы без отдельного «значения для печати» у колонки:
 * строки и числа как есть, теги/ссылки/Typography — их текст, списки —
 * через запятую. Иконки и кнопки без текста дают пустую строку. */
export function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    return node
      .map(nodeText)
      .filter((t) => t !== "")
      .join(node.every((n) => typeof n === "string" || typeof n === "number") ? "" : " ");
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; title?: ReactNode };
    // Свой простой компонент ячейки (StageCell и т.п.) — то, что он рисует;
    // компонент с хуками так не вызвать — тогда по его children/title.
    if (typeof node.type === "function" && !(node.type.prototype && node.type.prototype.isReactComponent)) {
      try {
        const out = nodeText((node.type as (p: unknown) => ReactNode)(node.props));
        if (out) return out;
      } catch {
        /* компонент с хуками — ниже, по children */
      }
    }
    const inner = nodeText(props.children);
    return inner || (typeof props.title === "string" ? props.title : "");
  }
  return "";
}

/** Число, если текст — число («1 234,5» → 1234.5): в Excel ячейка будет
 * числом, а не текстом. */
export function exportValue(text: string): string | number {
  const t = text.replace(/ |\s/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : text;
}
