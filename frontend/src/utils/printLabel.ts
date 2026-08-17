// Общие помощники печати этикеток (раздел про макеты для стеллажей/полок
// — вынесены из api/units.ts, где раньше жили только для этикеток
// рулонов, чтобы не дублировать эту же логику печати ещё раз для
// стеллажей). PDF на десктопе (термопринтер Codex G500 — прямая печать
// HTML из браузера ненадёжна, драйвер может обрезать нестандартный
// размер страницы; печать уже готового PDF, тот же путь, что у
// "Сохранить как PDF", эмпирически подтверждена рабочей). HTML на
// планшете/телефоне — печать PDF, открытого как blob, там оказалась
// ненадёжной: система перехватывает blob как файл на скачивание в обход
// печати ("сохраняет пдф вместо печати" — отчёт с планшета). Обычная
// HTML-страница печатается штатным Print Service Framework Android без
// этой проблемы.
export const isMobileDevice = () => /Android|iPad|iPhone|Mobile/i.test(navigator.userAgent);

export function printPdfBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.src = url;
  document.body.appendChild(iframe);
  iframe.onload = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
  };
  // Отзываем URL с запасом по времени, а не сразу — печать асинхронна,
  // системный диалог печати успевает открыться до того, как URL исчезнет.
  setTimeout(() => {
    document.body.removeChild(iframe);
    URL.revokeObjectURL(url);
  }, 60000);
}

export function printHtmlDoc(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  iframe.onload = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
  };
  const doc = iframe.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => document.body.removeChild(iframe), 60000);
}
