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

// Раздел про ориентацию печати — привязана к конкретному принтеру/месту
// печати на этом устройстве (как некоторые сборки этикетки нужно клеить
// повёрнутыми), а не к конкретной этикетке или разу печати, поэтому
// хранится в localStorage как настройка устройства, а не спрашивается
// каждый раз при печати. Размеры макета не меняются — сервер просто
// меняет местами ширину/высоту перед отрисовкой (см. api/labels.py
// _oriented), тот же макет, повёрнутый на 90°.
const VERTICAL_PRINT_KEY = "bdk-print-vertical";

export function isVerticalPrint(): boolean {
  return localStorage.getItem(VERTICAL_PRINT_KEY) === "1";
}

export function setVerticalPrint(value: boolean): void {
  localStorage.setItem(VERTICAL_PRINT_KEY, value ? "1" : "0");
}

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
  // Blob URL + src (тот же приём, что уже проверенно работает в
  // printPdfBlob выше), а не document.open/write/close — с document.write
  // на планшете при печати пачкой в несколько страниц (раздел про печать
  // этикеток с планшета — "не прогружает") воспроизводимо ловили гонку:
  // iframe успевал сгенерировать свой первый пустой "load" (about:blank)
  // и печать вызывалась раньше, чем содержимое реально дописано и
  // отрисовано, — на маленьком одиночном документе почти не заметно, на
  // пачке из полутора десятков страниц с QR-кодами вылезало стабильно.
  // Настоящая навигация на blob-URL такой гонки не даёт: "load" фактически
  // относится к готовому документу.
  const blob = new Blob([html], { type: "text/html" });
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
  setTimeout(() => {
    document.body.removeChild(iframe);
    URL.revokeObjectURL(url);
  }, 60000);
}
