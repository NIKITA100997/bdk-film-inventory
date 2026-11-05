import type { TaskPrintSheet } from "../api/productionOrders";
import { fmtDateTime } from "./dates";
import { renderQrSvg } from "./qrSvg";

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dm = (s: string | null) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : "");
const period = (a: string | null, b: string | null) => (a && b && a !== b ? `${dm(a)}—${dm(b)}` : dm(a));
type PrintSource = NonNullable<TaskPrintSheet["rows"][number]["source_orders"]>[number];
const sourceDetails = (sources: PrintSource[] | undefined) =>
  (sources ?? []).map((src) => `${esc(src.invoice_no || "Без счёта")} / ${esc(src.series || "Без серии")} — ${esc(src.qty)} шт.`).join("<br>");

/** Очистка наименования изделия от дублирования серии, размера, цвета и кромки. */
function cleanItemName(name: string): string {
  if (!name) return "—";
  const mFeat = name.match(/(?:с\s+молдинг\w*|под\s+замок\w*|стекло\s+[^,;]+)/gi);
  const featStr = mFeat ? mFeat.join(", ") : "";
  const low = name.toLowerCase();
  let base = name;
  if (low.includes("двер") || low.includes("щит")) {
    base = "Полотно щитовое";
  } else if (low.includes("панел")) {
    base = "Панель";
  } else if (low.includes("каркас")) {
    base = "Каркас";
  } else if (low.includes("заготовк")) {
    base = "Заготовка МДФ";
  }
  return featStr ? `${base} (${featStr})` : base;
}

/** Блок QR-кода наряда (для сканирования мастером камерой/планшетом). */
function qrBlock(tasks: { id: number }[]): string {
  if (!tasks.length) return "";
  if (tasks.length === 1) {
    const t = tasks[0];
    return `<div class="qr-side">${renderQrSvg(`TASK:${t.id}`, 70)}<div class="qr-text">TASK:${t.id}</div></div>`;
  }
  if (tasks.length <= 3) {
    return `<div class="qr-side qr-multi">${tasks
      .map((t) => `<div class="qr-item">${renderQrSvg(`TASK:${t.id}`, 58)}<div class="qr-text">TASK:${t.id}</div></div>`)
      .join("")}</div>`;
  }
  return `<div class="qr-side">${renderQrSvg(`TASK:${tasks[0].id}`, 70)}<div class="qr-text">TASK:${tasks[0].id} (+${tasks.length - 1})</div></div>`;
}

/** Шапка заказа в наряде: общий заказ и примечание. */
function orderHead(s: TaskPrintSheet): { title: string; html: string } {
  const orders = new Map<string, { ship: string | null; note: string | null }>();
  for (const t of s.tasks) if (t.order && !orders.has(t.order)) orders.set(t.order, { ship: t.ship_date, note: t.order_note ?? null });
  const list = [...orders.entries()];
  const title = list.map(([o]) => `Заказ ${o}`).join("; ");
  const html = list
    .map(
      ([o, v]) =>
        `<div class="order">Заказ ${esc(o)}${v.ship ? ` · отгрузка ${dm(v.ship)}` : ""}</div>${v.note ? `<div class="note">Примечание: ${esc(v.note)}</div>` : ""}`,
    )
    .join("");
  return { title, html };
}

/** Ведомость панелей (фрезеровка / распил / шлифовка МДФ). */
function panelPage(s: TaskPrintSheet, now: string): string {
  const groups = new Map<string, { mdf: string; sand: string; program: string; series: string; blank: string; qty: number; done: number; name: string; sources: Map<number, PrintSource>; sourceMissing: boolean }>();
  for (const r of s.rows) {
    const p = r.panel ?? { mdf: "", sand: "", series: r.series ?? "", blank: r.size ?? "" };
    const blank = p.blank || r.size || "";
    const series = p.series || r.series || "";
    const mdf = p.mdf || (r.name.includes("Kastamonu") ? "Kastamonu" : r.name.includes("Беларусь") ? "Беларусь" : "МДФ");
    const k = [mdf, p.sand, r.program ?? "", series, blank, r.panel ? "" : r.name].join("|");
    const g = groups.get(k) ?? { ...p, mdf, series, blank, program: r.program ?? "", qty: 0, done: 0, name: r.panel ? "" : r.name, sources: new Map(), sourceMissing: false };
    g.qty += r.qty;
    g.done += r.done;
    g.sourceMissing ||= Boolean(r.source_missing);
    for (const src of r.source_orders ?? []) {
      const old = g.sources.get(src.order_line_id);
      g.sources.set(src.order_line_id, { ...src, qty: (old?.qty ?? 0) + src.qty });
    }
    groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) =>
    [a.mdf, a.program, a.series, a.blank].join("|").localeCompare([b.mdf, b.program, b.series, b.blank].join("|"), "ru"),
  );
  const rows = list
    .map(
      (g, i) => `<tr>
<td class="n">${i + 1}</td><td><b>${esc(g.mdf || "МДФ")}</b></td><td>${esc(g.sand || "—")}</td>
<td>${g.program ? `<b>${esc(g.program)}</b>` : g.name ? esc(g.name) : '<span class="warn">уточнить программу</span>'}</td>
<td><b>${esc(g.series || "—")}</b></td><td class="nw"><b>${esc(g.blank || "—")}</b></td>
<td>${sourceDetails([...g.sources.values()]) || (g.sourceMissing ? '<span class="warn">источник не восстановлен — сверить</span>' : "")}</td>
<td class="q"><b>${Math.round(g.qty * 100) / 100}</b></td><td class="q">${g.done ? Math.round(g.done * 100) / 100 : ""}</td>
<td class="w"></td><td class="w"></td><td class="w"></td>
</tr>`,
    )
    .join("");
  const head = ["№", "МДФ", "Шлифовка / Цвет", "Программа / Наименование", "Серия", "Размер заготовки", "Счета / серии / кол-во", "Кол-во, шт", "Сделано", "Годно", "Брак", "Подпись"];
  const oh = orderHead(s);
  return `<section class="page">
<div class="top-header">
  <div class="info-side">
    ${oh.html}
    <h1>Наряд-ведомость: ${esc(s.area_name)}</h1>
    <div class="meta">${esc(s.site ?? "")}${s.site ? " · " : ""}позиций ${list.length}, всего ${s.total} шт · напечатано ${esc(now)}</div>
    <div class="meta"><b>Задания:</b> ${s.tasks.map((t) => `№${t.id}`).join(", ")}</div>
  </div>
  ${qrBlock(s.tasks)}
</div>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
<div class="sign">Выдал: ____________________ &nbsp;&nbsp; Принял (мастер): ____________________ &nbsp;&nbsp; Дата: ________</div>
</section>`;
}

/** Ведомость склейки щитов (подбор каркаса, панелей и наполнителя). */
function skleykaPage(s: TaskPrintSheet, now: string): string {
  const hasMultipleSources = s.rows.some((r) => (r.source_orders?.length ?? 0) > 1);
  const rows = s.rows
    .map(
      (r, i) => `<tr>
<td class="n">${i + 1}</td>
${r.invoice_no ? `<td class="nw">${esc(r.invoice_no)}</td>` : r.source_missing ? '<td><span class="warn">источник не восстановлен — сверить</span></td>' : "<td></td>"}
<td><b>${esc(r.series || "—")}</b></td>
${hasMultipleSources ? `<td>${(r.source_orders?.length ?? 0) > 1 ? sourceDetails(r.source_orders) : r.source_missing ? '<span class="warn">источник не восстановлен — сверить</span>' : ""}</td>` : ""}
<td class="nw"><b>${esc(r.size || "—")}</b></td>
<td>${esc(r.color || "—")}</td>
<td class="q"><b>${Math.round(r.qty * 100) / 100}</b></td>
<td><b>${esc(r.skleyka?.frame || "—")}</b></td>
<td>${esc(r.skleyka?.panels || "—")}</td>
<td>${esc(r.skleyka?.foam || "—")}</td>
<td class="q">${r.done ? Math.round(r.done * 100) / 100 : ""}</td>
<td class="w"></td><td class="w"></td><td class="w"></td>
</tr>`,
    )
    .join("");

  const head = [
    "№",
    "Счёт",
    "Серия",
    ...(hasMultipleSources ? ["Состав заказа"] : []),
    "Размер",
    "Цвет / Отделка",
    "Кол-во, шт",
    "Каркас (1 шт)",
    "Панели МДФ (2 шт)",
    "Наполнитель",
    "Сделано",
    "Годно",
    "Брак",
    "Подпись",
  ];
  const oh = orderHead(s);
  return `<section class="page">
<div class="top-header">
  <div class="info-side">
    ${oh.html}
    <h1>Наряд-склейка: ${esc(s.area_name)}</h1>
    <div class="meta">${esc(s.site ?? "")}${s.site ? " · " : ""}дверей ${s.rows.length}, всего ${s.total} шт · напечатано ${esc(now)}</div>
    <div class="meta"><b>Задания:</b> ${s.tasks.map((t) => `№${t.id}`).join(", ")}</div>
  </div>
  ${qrBlock(s.tasks)}
</div>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
${componentsTable(s)}
<div class="sign">Выдал: ____________________ &nbsp;&nbsp; Принял (мастер): ____________________ &nbsp;&nbsp; Дата: ________</div>
</section>`;
}

/** Комплектующие без своего маршрута (детали каркаса на сборке, пенопласт). */
function componentsTable(s: TaskPrintSheet): string {
  const list = s.components ?? [];
  if (!list.length) return "";
  const hasCut = list.some((c) => c.comment);
  const rows = list
    .map(
      (c, i) => `<tr><td class="n">${i + 1}</td><td><b>${esc(c.name)}</b></td><td class="q"><b>${c.qty}</b></td>${
        hasCut ? `<td><b>${esc(c.comment ?? "")}</b></td>` : ""
      }<td class="w"></td></tr>`,
    )
    .join("");
  return `<h2 style="font-size:13px;margin:10px 0 4px">Расход комплектующих и материалов:</h2>
<table><thead><tr><th>№</th><th>Деталь / Комплектующее</th><th>Кол-во, шт</th>${hasCut ? "<th>Как пилить / шлифовать / раскраивать</th>" : ""}<th>Фактический расход</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Сводный лист по группам участков. */
function groupsPage(s: TaskPrintSheet, now: string): string {
  const groups = s.groups ?? [];
  const rows = groups
    .map(
      (g, i) => `<tr>
<td class="n">${i + 1}</td>
<td><b>${esc(g.label)}</b>${g.lines > 1 ? `<div class="sub">${g.lines} строк в задании</div>` : ""}</td>
<td>${esc(g.invoices.join(", ")) || (g.unresolved ? '<span class="warn">источник не восстановлен — сверить</span>' : "")}</td>
<td class="nw">${esc(period(g.date_from, g.date_to))}</td>
<td class="q">${g.qty}${g.done ? `<div class="sub">готово ${g.done}</div>` : ""}</td>
<td class="w"></td><td class="w"></td><td class="w"></td>
</tr>`,
    )
    .join("");
  const total = groups.reduce((a, g) => a + g.qty, 0);
  const oh = orderHead(s);
  return `<section class="page">
<div class="top-header">
  <div class="info-side">
    ${oh.html}
    <h1>${esc(s.area_name)}</h1>
    <div class="meta">${esc(s.site ?? "")}${s.site ? " · " : ""}групп ${groups.length}, всего ${total} шт · напечатано ${esc(now)}</div>
    <div class="meta"><b>Задания:</b> ${s.tasks.map((t) => `№${t.id}`).join(", ")}</div>
  </div>
  ${qrBlock(s.tasks)}
</div>
<table><thead><tr>${["№", "Что делать (группа)", "Счета", "Срок", "Кол-во", "Сделано", "Брак", "Подпись"].map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
${componentsTable(s)}
<div class="sign">Выдал: ____________________ &nbsp;&nbsp; Принял (мастер): ____________________ &nbsp;&nbsp; Дата: ________</div>
</section>`;
}

/** Пакетная печать нарядов с учётом специфики участков. */
export function printTaskSheets(sheets: TaskPrintSheet[], title = "Задания участкам") {
  const now = fmtDateTime(new Date());
  const orderTitles = [...new Set(sheets.map((s) => orderHead(s).title).filter(Boolean))];
  if (orderTitles.length === 1 && !title.includes(orderTitles[0].replace(/^Заказ /, ""))) title = `${orderTitles[0]} — ${title}`;
  const pages = sheets
    .map((s) => {
      const areaLow = (s.area_name || "").toLowerCase();
      const isPanelArea = /фрезер.*панел|шлиф.*панел|распил.*мдф|склейк.*мдф|панел|мдф/i.test(areaLow);
      if (isPanelArea && s.rows.some((r) => r.panel)) return panelPage(s, now);

      const isSkleykaArea = /склейк.*щит|skleyka_shchitov/i.test(areaLow);
      if (isSkleykaArea && s.rows.some((r) => r.skleyka)) return skleykaPage(s, now);

      if ((s.groups ?? []).length > 0 && (s.groups ?? []).length < s.rows.length && !s.rows.some((r) => r.size || r.series)) {
        return groupsPage(s, now);
      }

      const hasSize = s.rows.some((r) => r.size);
      const hasSeries = s.rows.some((r) => r.series);
      const hasMultipleSources = s.rows.some((r) => (r.source_orders?.length ?? 0) > 1);
      const hasColor = s.rows.some((r) => r.color);
      const hasFilm = s.rows.some((r) => r.film);
      const hasProg = s.rows.some((r) => r.program || r.instruction);
      const hasInv = s.rows.some((r) => r.invoice_no);
      const hasEdge = /периметр|кромк/i.test(areaLow) && s.rows.some((r) => r.edge || r.edge_type);

      const head = [
        "№",
        ...(hasInv ? ["Счёт"] : []),
        ...(hasSeries ? ["Серия"] : []),
        ...(hasMultipleSources ? ["Состав заказа"] : []),
        "Деталь / Наименование",
        ...(hasSize ? ["Размер"] : []),
        ...(hasColor ? ["Цвет"] : []),
        "Кол-во, шт",
        ...(hasEdge ? ["Тип кромки", "Цвет кромки", "Сторон"] : []),
        ...(hasFilm ? ["Плёнка / Штрипс"] : []),
        ...(hasProg ? ["Программа / указание"] : []),
        "Срок",
        "Готово",
        "Сделано",
        "Брак",
        "Подпись",
      ];

      const rows = s.rows
        .map(
          (r, i) => {
            const displayName = hasEdge || (hasSeries && hasSize) ? cleanItemName(r.name || r.source || "") : (r.name || r.source || "—");
            const showSourceSub = r.source && r.source !== r.name && !hasEdge && !(hasSeries && hasSize);
            return `<tr>
<td class="n">${i + 1}</td>
${hasInv ? `<td class="nw">${esc(r.invoice_no ?? "")}</td>` : ""}
${hasSeries ? `<td class="nw"><b>${esc(r.series ?? "")}</b></td>` : ""}
${hasMultipleSources ? `<td>${(r.source_orders?.length ?? 0) > 1 ? sourceDetails(r.source_orders) : r.source_missing ? '<span class="warn">источник не восстановлен — сверить</span>' : ""}</td>` : ""}
<td><b>${esc(displayName)}</b>${showSourceSub ? `<div class="sub">${esc(r.source)}</div>` : ""}${r.source_missing ? '<div class="warn">Источник счёта и серии не восстановлен — требуется сверка</div>' : ""}</td>
${hasSize ? `<td class="nw"><b>${esc(r.size ?? "")}</b></td>` : ""}
${hasColor ? `<td>${esc(r.color ?? "")}</td>` : ""}
<td class="q"><b>${Math.round(r.qty * 100) / 100}</b></td>
${hasEdge ? `<td class="nw">${r.edge_type?.includes("?") ? `<span class="warn">${esc(r.edge_type)}</span>` : `<b>${esc(r.edge_type ?? "")}</b>`}</td><td>${esc(r.edge_color ?? "")}</td><td class="q"><b>${r.edge_sides ? `${r.edge_sides}х` : (r.edge_type ? '<span class="warn">?</span>' : "")}</b></td>` : ""}
${hasFilm ? `<td>${esc(r.film ?? "")}</td>` : ""}
${hasProg ? `<td>${r.program ? `<b>${esc(r.program)}</b>` : ""}${r.instruction ? `<div class="warn">⚑ ${esc(r.instruction)}</div>` : ""}</td>` : ""}
<td class="nw">${esc(period(r.date_from, r.date_to))}</td>
<td class="q">${r.done ? Math.round(r.done * 100) / 100 : ""}</td>
<td class="w"></td><td class="w"></td><td class="w"></td>
</tr>`;
          },
        )
        .join("");
      const oh = orderHead(s);
      return `<section class="page">
<div class="top-header">
  <div class="info-side">
    ${oh.html}
    <h1>Наряд: ${esc(s.area_name)}</h1>
    <div class="meta">${esc(s.site ?? "")}${s.site ? " · " : ""}строк ${s.rows.length}, всего ${s.total} шт · напечатано ${esc(now)}</div>
    <div class="meta"><b>Задания:</b> ${s.tasks.map((t) => `№${t.id}`).join(", ")}</div>
  </div>
  ${qrBlock(s.tasks)}
</div>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
${componentsTable(s)}
<div class="sign">Выдал: ____________________ &nbsp;&nbsp; Принял (мастер): ____________________ &nbsp;&nbsp; Дата: ________</div>
</section>`;
    })
    .join("");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  body { font-family: "Calibri", "Segoe UI", Arial, sans-serif; color: #222; margin: 0; }
  .page { page-break-after: always; padding: 4mm 2mm; }
  .page:last-child { page-break-after: auto; }
  .top-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; margin-bottom: 4px; }
  .info-side { flex: 1; min-width: 0; }
  .qr-side { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; border: 1px solid #ccc; padding: 3px 5px; border-radius: 4px; background: #fff; flex-shrink: 0; }
  .qr-side.qr-multi { flex-direction: row; gap: 8px; }
  .qr-item { display: flex; flex-direction: column; align-items: center; }
  .qr-text { font-size: 9px; font-family: monospace; font-weight: bold; margin-top: 2px; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-top: 6px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { background: #eee; font-size: 11px; }
  td.n { width: 22px; text-align: right; color: #555; }
  td.q { text-align: right; white-space: nowrap; font-weight: 600; }
  td.nw { white-space: nowrap; }
  td.w { width: 34px; }
  .warn { color: #d46b08; font-weight: bold; }
  .sub { font-size: 10px; color: #666; font-weight: normal; }
  .order { font-weight: bold; font-size: 13px; }
  .note { font-size: 11px; color: #444; margin-bottom: 4px; }
  .sign { margin-top: 14px; font-size: 11px; }
</style></head><body>${pages}</body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
}
