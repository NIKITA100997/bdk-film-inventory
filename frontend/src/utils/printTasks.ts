import type { TaskPrintSheet } from "../api/productionOrders";
import { fmtDateTime } from "./dates";

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dm = (s: string | null) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : "");
const period = (a: string | null, b: string | null) => (a && b && a !== b ? `${dm(a)}–${dm(b)}` : dm(a));

/** Что делать — характеристиками изделия («В-10 800×2000 · ПЭТ Бежевый ·
 * молдинг · кромка ABS черная»), у п/ф — название детали. */
function what(r: TaskPrintSheet["rows"][number]): string {
  if (!r.chars.length) return esc(r.name);
  const by = Object.fromEntries(r.chars.map((c) => [c.code, c.value]));
  const num = (v?: string) => (v ?? "").replace(/\s*мм$/, "");
  const parts = [
    [by["серия"], by["ширина"] && by["высота"] ? `${num(by["ширина"])}×${num(by["высота"])}` : ""].filter(Boolean).join(" "),
    by["цвет"],
    ...r.chars.filter((c) => !["серия", "ширина", "высота", "цвет", "кромка", "цвет_кромки", "стекло"].includes(c.code)).map((c) => (c.value === "да" ? c.name.toLowerCase() : `${c.name}: ${c.value}`)),
    by["стекло"] ? `стекло ${by["стекло"]}` : "",
    [by["кромка"] ? `кромка ${by["кромка"]}` : "", by["цвет_кромки"] ?? ""].filter(Boolean).join(" "),
  ].filter(Boolean);
  return `<b>${esc(parts[0] ?? r.name)}</b>${parts.length > 1 ? ` · ${esc(parts.slice(1).join(" · "))}` : ""}`;
}

/** Пакетная печать заданий: лист на участок (новая страница), строки всех
 * выбранных заданий участка, графы «Сделано / Брак / Подпись» — от руки. */
export function printTaskSheets(sheets: TaskPrintSheet[], title = "Задания участкам") {
  const now = fmtDateTime(new Date());
  const pages = sheets
    .map((s) => {
      const hasFilm = s.rows.some((r) => r.film);
      const hasProg = s.rows.some((r) => r.program || r.instruction);
      const hasInv = s.rows.some((r) => r.invoice_no);
      const head = [
        "№",
        "Что делать",
        ...(hasInv ? ["Счёт"] : []),
        "Срок",
        "Кол-во",
        ...(hasFilm ? ["Плёнка"] : []),
        ...(hasProg ? ["Программа / указание"] : []),
        "Сделано",
        "Брак",
        "Подпись",
      ];
      const rows = s.rows
        .map(
          (r, i) => `<tr>
<td class="n">${i + 1}</td>
<td>${what(r)}${r.chars.length ? `<div class="sub">${esc(r.name)}</div>` : ""}</td>
${hasInv ? `<td>${esc(r.invoice_no ?? "")}</td>` : ""}
<td class="nw">${esc(period(r.date_from, r.date_to))}</td>
<td class="q">${r.qty}${r.done ? `<div class="sub">сделано ${r.done}</div>` : ""}</td>
${hasFilm ? `<td>${esc(r.film ?? "")}</td>` : ""}
${hasProg ? `<td>${r.program ? `<b>${esc(r.program)}</b>` : ""}${r.instruction ? `<div class="warn">⚑ ${esc(r.instruction)}</div>` : ""}</td>` : ""}
<td class="w"></td><td class="w"></td><td class="w"></td>
</tr>`,
        )
        .join("");
      const orders = [...new Set(s.tasks.map((t) => [t.order, t.ship_date ? `отгрузка ${dm(t.ship_date)}` : ""].filter(Boolean).join(", ")))]
        .filter(Boolean)
        .join("; ");
      return `<section class="page">
<div class="top"><h1>${esc(s.area_name)}</h1><div class="meta">${esc(s.site ?? "")}${s.site ? " · " : ""}строк ${s.rows.length}, всего ${s.total} шт · напечатано ${esc(now)}</div></div>
${orders ? `<div class="meta">${esc(orders)}</div>` : ""}
<div class="meta">Задания: ${s.tasks.map((t) => `№${t.id}`).join(", ")}</div>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
<div class="sign">Выдал: ____________________ &nbsp;&nbsp; Принял (мастер): ____________________ &nbsp;&nbsp; Дата: ________</div>
</section>`;
    })
    .join("");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: "Calibri", "Segoe UI", Arial, sans-serif; color: #222; margin: 0; }
  .page { page-break-after: always; padding: 4mm 2mm; }
  .page:last-child { page-break-after: auto; }
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-top: 6px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; font-size: 11px; }
  td.n { width: 22px; text-align: right; color: #555; }
  td.q { text-align: right; white-space: nowrap; font-weight: 600; }
  td.nw { white-space: nowrap; }
  td.w { width: 64px; }
  .sub { font-size: 10px; color: #666; font-weight: 400; }
  .warn { font-size: 11px; color: #9a5b00; }
  .sign { font-size: 12px; margin-top: 14px; }
  .bar { position: sticky; top: 0; background: #fff; padding: 8px; border-bottom: 1px solid #ddd; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">Печать</button> &nbsp; Листов: ${sheets.length}</div>
${pages || "<p>Нечего печатать</p>"}
</body></html>`;
  const w = window.open("", "_blank", "width=1100,height=900");
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
