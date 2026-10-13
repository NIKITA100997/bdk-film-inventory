import type { TaskPrintSheet } from "../api/productionOrders";
import { fmtDateTime } from "./dates";

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dm = (s: string | null) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : "");
const period = (a: string | null, b: string | null) => (a && b && a !== b ? `${dm(a)}–${dm(b)}` : dm(a));

/** Шапка листа (13.10): общий заказ (заказы) с отгрузкой и комментарий
 * заказа — на каждом задании. */
function orderHead(s: TaskPrintSheet): { title: string; html: string } {
  const orders = new Map<string, { ship: string | null; note: string | null }>();
  for (const t of s.tasks) if (t.order && !orders.has(t.order)) orders.set(t.order, { ship: t.ship_date, note: t.order_note ?? null });
  const list = [...orders.entries()];
  const title = list.map(([o]) => `Заказ ${o}`).join("; ");
  const html = list
    .map(
      ([o, v]) =>
        `<div class="order">Заказ ${esc(o)}${v.ship ? ` · отгрузка ${dm(v.ship)}` : ""}</div>${v.note ? `<div class="note">Комментарий: ${esc(v.note)}</div>` : ""}`,
    )
    .join("");
  return { title, html };
}

/** Ведомость панелей (07.10) — как лист «Панели фабрика / Северный» в Excel:
 * МДФ, Шлифовка/Цвет, программа, модель, размер заготовки (толщина первой);
 * одинаковые строки сложены. */
function panelPage(s: TaskPrintSheet, now: string): string {
  const groups = new Map<string, { mdf: string; sand: string; program: string; series: string; blank: string; qty: number; done: number; name: string }>();
  for (const r of s.rows) {
    const p = r.panel ?? { mdf: "", sand: "", series: "", blank: "" };
    const k = [p.mdf, p.sand, r.program ?? "", p.series, p.blank, r.panel ? "" : r.name].join("|");
    const g = groups.get(k) ?? { ...p, program: r.program ?? "", qty: 0, done: 0, name: r.panel ? "" : r.name };
    g.qty += r.qty;
    g.done += r.done;
    groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) =>
    [a.mdf, a.program, a.series, a.blank].join("|").localeCompare([b.mdf, b.program, b.series, b.blank].join("|"), "ru"),
  );
  const rows = list
    .map(
      (g, i) => `<tr>
<td class="n">${i + 1}</td><td>${esc(g.mdf)}</td><td>${esc(g.sand)}</td>
<td>${g.program ? `<b>${esc(g.program)}</b>` : g.name ? esc(g.name) : '<span class="warn">уточнить у конструктора</span>'}</td>
<td>${esc(g.series)}</td><td class="nw">${esc(g.blank)}</td>
<td class="q">${Math.round(g.qty * 100) / 100}</td><td class="q">${g.done ? Math.round(g.done * 100) / 100 : ""}</td>
<td class="w"></td><td class="w"></td><td class="w"></td>
</tr>`,
    )
    .join("");
  const head = ["№", "МДФ", "Шлифовка / цвет", "Программа фрезеровки", "Модель", "Размер заготовки", "Кол-во", "Готово", "Сделано", "Брак", "Подпись"];
  const oh = orderHead(s);
  return `<section class="page">
${oh.html}
<div class="top"><h1>Ведомость: ${esc(s.area_name)}</h1><div class="meta">${esc(s.site ?? "")}${s.site ? " · " : ""}позиций ${list.length}, всего ${s.total} шт · напечатано ${esc(now)}</div></div>
<div class="meta">Задания: ${s.tasks.map((t) => `№${t.id}`).join(", ")}</div>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
<div class="sign">Выдал: ____________________ &nbsp;&nbsp; Принял (мастер): ____________________ &nbsp;&nbsp; Дата: ________</div>
</section>`;
}

/** Комплектующие на все строки листа (детали каркаса): сколько напилить
 * и в какую толщину — как лист «Каркас» в Excel. */
function componentsTable(s: TaskPrintSheet): string {
  const list = s.components ?? [];
  if (!list.length) return "";
  const hasCut = list.some((c) => c.comment);
  const rows = list
    .map(
      (c, i) => `<tr><td class="n">${i + 1}</td><td>${esc(c.name)}</td><td class="q">${c.qty}</td>${
        hasCut ? `<td><b>${esc(c.comment ?? "")}</b></td>` : ""
      }<td class="w"></td></tr>`,
    )
    .join("");
  return `<h2 style="font-size:14px;margin:12px 0 4px">Комплектующие</h2>
<table><thead><tr><th>№</th><th>Деталь</th><th>Кол-во</th>${hasCut ? "<th>Пилим / шлифуем</th>" : ""}<th>Готово</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Лист участка по группам (08.10): одинаковые признаки — одна строка,
 * счета — списком; подробные строки заказов — на экране задания. */
function groupsPage(s: TaskPrintSheet, now: string): string {
  const groups = s.groups ?? [];
  const rows = groups
    .map(
      (g, i) => `<tr>
<td class="n">${i + 1}</td>
<td><b>${esc(g.label)}</b>${g.lines > 1 ? `<div class="sub">${g.lines} строк заказов</div>` : ""}</td>
<td>${esc(g.invoices.join(", "))}</td>
<td class="nw">${esc(period(g.date_from, g.date_to))}</td>
<td class="q">${g.qty}${g.done ? `<div class="sub">сделано ${g.done}</div>` : ""}</td>
<td class="w"></td><td class="w"></td><td class="w"></td>
</tr>`,
    )
    .join("");
  const total = groups.reduce((a, g) => a + g.qty, 0);
  const oh = orderHead(s);
  return `<section class="page">
${oh.html}
<div class="top"><h1>${esc(s.area_name)}</h1><div class="meta">${esc(s.site ?? "")}${s.site ? " · " : ""}групп ${groups.length}, всего ${total} шт · напечатано ${esc(now)}</div></div>
<div class="meta">Задания: ${s.tasks.map((t) => `№${t.id}`).join(", ")}</div>
<table><thead><tr>${["№", "Что делать", "Счета", "Срок", "Кол-во", "Сделано", "Брак", "Подпись"].map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
${componentsTable(s)}
<div class="sign">Выдал: ____________________ &nbsp;&nbsp; Принял (мастер): ____________________ &nbsp;&nbsp; Дата: ________</div>
</section>`;
}

/** Пакетная печать заданий: лист на участок (новая страница), строки всех
 * выбранных заданий участка, графы «Сделано / Брак / Подпись» — от руки. */
export function printTaskSheets(sheets: TaskPrintSheet[], title = "Задания участкам") {
  const now = fmtDateTime(new Date());
  // в названии файла/окна — общий заказ (13.10)
  const orderTitles = [...new Set(sheets.map((s) => orderHead(s).title).filter(Boolean))];
  if (orderTitles.length === 1 && !title.includes(orderTitles[0].replace(/^Заказ /, ""))) title = `${orderTitles[0]} — ${title}`;
  const pages = sheets
    .map((s) => {
      if (s.rows.some((r) => r.panel)) return panelPage(s, now);
      if ((s.groups ?? []).length > 0 && (s.groups ?? []).length < s.rows.length) return groupsPage(s, now);
      // столбцы как в Excel-мониторе (13.10): у дверей № счёта | Серия |
      // Размер | Цвет | Наименование — каждое отдельно, без повторов
      const doors = s.rows.some((r) => r.series || r.size);
      const hasFilm = s.rows.some((r) => r.film);
      const hasProg = s.rows.some((r) => r.program || r.instruction);
      const hasInv = s.rows.some((r) => r.invoice_no);
      // фрезеровка периметра: кромка обязательна, у ABS — с толщиной
      const hasEdge = doors && /периметр/i.test(s.area_name) && s.rows.some((r) => r.edge);
      const head = [
        "№",
        ...(hasInv ? ["№ счёта"] : []),
        ...(doors ? ["Серия", "Размер", "Цвет"] : []),
        "Наименование",
        doors ? "Кол-во дверей" : "Кол-во",
        ...(hasEdge ? ["Кромка"] : []),
        ...(hasFilm ? ["Плёнка"] : []),
        ...(hasProg ? ["Программа / указание"] : []),
        "Срок",
        "Готово",
        "Сделано",
        "Брак",
        "Подпись",
      ];
      const rows = s.rows
        .map(
          (r, i) => `<tr>
<td class="n">${i + 1}</td>
${hasInv ? `<td class="nw">${esc(r.invoice_no ?? "")}</td>` : ""}
${doors ? `<td class="nw">${esc(r.series ?? "")}</td><td class="nw">${esc(r.size ?? "")}</td><td>${esc(r.color ?? "")}</td>` : ""}
<td>${esc(r.source || r.name)}</td>
<td class="q">${r.qty}</td>
${hasEdge ? `<td class="nw">${r.edge?.includes("?") ? `<span class="warn">${esc(r.edge)}</span>` : `<b>${esc(r.edge ?? "")}</b>`}</td>` : ""}
${hasFilm ? `<td>${esc(r.film ?? "")}</td>` : ""}
${hasProg ? `<td>${r.program ? `<b>${esc(r.program)}</b>` : ""}${r.instruction ? `<div class="warn">⚑ ${esc(r.instruction)}</div>` : ""}</td>` : ""}
<td class="nw">${esc(period(r.date_from, r.date_to))}</td>
<td class="q">${r.done ? r.done : ""}</td>
<td class="w"></td><td class="w"></td><td class="w"></td>
</tr>`,
        )
        .join("");
      const oh = orderHead(s);
      return `<section class="page">
${oh.html}
<div class="top"><h1>${esc(s.area_name)}</h1><div class="meta">${esc(s.site ?? "")}${s.site ? " · " : ""}строк ${s.rows.length}, всего ${s.total} шт · напечатано ${esc(now)}</div></div>
<div class="meta">Задания: ${s.tasks.map((t) => `№${t.id}`).join(", ")}</div>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
${componentsTable(s)}
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
  .order { font-size: 15px; font-weight: 700; margin-bottom: 2px; }
  .note { font-size: 13px; margin: 2px 0 6px; padding: 4px 6px; border: 1px solid #c9a36b; background: #fff7e8; }
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
