/** Печатная форма отчёта (5 раздел обратной связи) — HTML-страница через
 * браузер, без PDF-библиотек (в отличие от этикеток — там прямая печать
 * HTML на термопринтере оказалась ненадёжной, см. api/labels.ts/units.ts
 * printLabel, — а отчёты печатаются на обычный принтер, где эта проблема
 * не встречалась). Печатает только те столбцы, что выбраны в конструкторе
 * — состав печатной формы регулируется тем же списком, что и видимость
 * столбцов на экране. */
export function printReport(title: string, columns: { key: string; header: string }[], rows: Record<string, unknown>[]) {
  const escapeHtml = (v: unknown) =>
    String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const headerRow = columns.map((c) => `<th>${escapeHtml(c.header)}</th>`).join("");
  const bodyRows = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(r[c.key])}</td>`).join("")}</tr>`)
    .join("");

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: "Calibri", "Segoe UI", Arial, sans-serif; margin: 24px; color: #2C2E3A; }
  h1 { font-size: 16px; font-family: "Cambria", Georgia, serif; margin: 0 0 4px; }
  .meta { font-size: 11px; color: #8A8C99; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #DEDEDA; padding: 5px 9px; text-align: left; }
  th { background: #F5F5F4; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(new Date().toLocaleString("ru-RU"))} · строк: ${rows.length}</div>
  <table>
    <thead><tr>${headerRow}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div class="no-print" style="margin-top: 16px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>`;

  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
