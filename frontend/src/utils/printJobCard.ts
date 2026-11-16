import type { JobCardData } from "../api/production";
import { fmtDateTime } from "./dates";
import { renderQrSvg } from "./qrSvg";

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Печать сменного наряда-задания / маршрутной карты на станок (Job Card). */
export function printJobCard(card: JobCardData, qrDataUrl?: string) {
  const now = fmtDateTime(new Date());

  const areaText = `${card.area_name || ""} ${card.area_code || ""}`.toLowerCase();
  const isMilling = /фрезер|мдф|панел|чпу|cnc/i.test(areaText);
  const isEdgebanding = /кромк|периметр|edge/i.test(areaText);
  const isCarcass = /каркас|сборк.*щит|склейк|skleyka|kle[yj]/i.test(areaText);
  const isWrapping = /окутк|погонаж|царг|фабрик|wrap/i.test(areaText);

  const materialsRows = card.materials
    .map(
      (m, i) => `<tr>
    <td class="n">${i + 1}</td>
    <td><b>${esc(m.color || "—")}</b> ${esc(m.material || "")}</td>
    <td class="q">${m.thickness ? `${m.thickness} мм` : "—"}</td>
    <td class="q">${m.strip_width_mm ? `${Math.round(m.strip_width_mm)} мм` : "—"}</td>
    <td class="q"><b>${m.planned_meters} м</b></td>
    <td class="q">${m.issued_meters ? `${m.issued_meters} м` : "—"}</td>
    <td>${esc(m.rolls_assigned.join(", ") || "—")}</td>
  </tr>`,
    )
    .join("");

  let theadHtml = "";
  let linesRows = "";

  if (isMilling) {
    // 1. Участок фрезеровки / ЧПУ / раскроя МДФ
    theadHtml = `<tr>
      <th>№</th>
      <th>Наименование детали / Профиль</th>
      <th>Размеры (Длина x Ширина x Толщина)</th>
      <th>Программа ЧПУ</th>
      <th>Указания / Фреза</th>
      <th>План, шт</th>
      <th>Сдано, шт</th>
      <th style="background:#fff3e0">Сделано, шт</th>
      <th style="background:#ffebee">Брак, шт</th>
      <th>Подпись оператора</th>
    </tr>`;

    linesRows = card.lines
      .map(
        (l, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(l.part_name || "Деталь")}</b>${l.operation_name ? `<div class="sub">${esc(l.operation_name)}</div>` : ""}</td>
      <td class="nw"><b>${esc(l.dimensions)}</b></td>
      <td>${l.program ? `<span class="cnc-badge"><b>${esc(l.program)}</b></span>` : '<span class="warn">уточнить ЧПУ</span>'}</td>
      <td>${l.instruction ? `<div class="warn">⚑ ${esc(l.instruction)}</div>` : "—"}</td>
      <td class="q big">${Math.round(l.quantity_pieces)}</td>
      <td class="q">${l.produced_good_pieces ? Math.round(l.produced_good_pieces) : "0"}</td>
      <td class="w"></td>
      <td class="w"></td>
      <td class="w wide"></td>
    </tr>`,
      )
      .join("");
  } else if (isEdgebanding) {
    // 2. Участок кромкооблицовки / периметра
    theadHtml = `<tr>
      <th>№</th>
      <th>Наименование детали / Полотно</th>
      <th>Размеры (Длина x Ширина x Толщина)</th>
      <th>Тип кромки (толщина)</th>
      <th>Цвет кромки</th>
      <th>Сторон</th>
      <th>План, шт</th>
      <th>Сдано, шт</th>
      <th style="background:#fff3e0">Сделано, шт</th>
      <th style="background:#ffebee">Брак, шт</th>
      <th>Подпись оператора</th>
    </tr>`;

    linesRows = card.lines
      .map(
        (l, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(l.part_name || "Полотно")}</b>${l.operation_name ? `<div class="sub">${esc(l.operation_name)}</div>` : ""}</td>
      <td class="nw"><b>${esc(l.dimensions)}</b></td>
      <td class="nw"><b>${esc(l.edge_type || "ABS")}</b></td>
      <td>${esc(l.edge_color || "—")}</td>
      <td class="q"><b>${l.edge_sides ? `${l.edge_sides}х` : (l.edge_type ? "—" : "—")}</b></td>
      <td class="q big">${Math.round(l.quantity_pieces)}</td>
      <td class="q">${l.produced_good_pieces ? Math.round(l.produced_good_pieces) : "0"}</td>
      <td class="w"></td>
      <td class="w"></td>
      <td class="w wide"></td>
    </tr>`,
      )
      .join("");
  } else if (isCarcass) {
    // 3. Участок сборки каркасов / склейки щитов
    theadHtml = `<tr>
      <th>№</th>
      <th>Наименование изделия / Деталь</th>
      <th>Размеры (Длина x Ширина x Толщина)</th>
      <th>Спецификация / Примечание</th>
      <th>Программа / Схема</th>
      <th>План, шт</th>
      <th>Сдано, шт</th>
      <th style="background:#fff3e0">Сделано, шт</th>
      <th style="background:#ffebee">Брак, шт</th>
      <th>Подпись сборщика</th>
    </tr>`;

    linesRows = card.lines
      .map(
        (l, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(l.part_name || "Каркас")}</b>${l.operation_name ? `<div class="sub">${esc(l.operation_name)}</div>` : ""}</td>
      <td class="nw"><b>${esc(l.dimensions)}</b></td>
      <td>${l.instruction ? `<div class="warn">⚑ ${esc(l.instruction)}</div>` : esc(l.material_label || "—")}</td>
      <td>${l.program ? `<code>${esc(l.program)}</code>` : "—"}</td>
      <td class="q big">${Math.round(l.quantity_pieces)}</td>
      <td class="q">${l.produced_good_pieces ? Math.round(l.produced_good_pieces) : "0"}</td>
      <td class="w"></td>
      <td class="w"></td>
      <td class="w wide"></td>
    </tr>`,
      )
      .join("");
  } else {
    // 4. Окутка царговых / погонаж (или общий случай)
    theadHtml = `<tr>
      <th>№</th>
      <th>Наименование детали / Передел</th>
      <th>Размеры (Длина x Ширина x Толщина)</th>
      <th>Штрипс</th>
      <th>Программа ЧПУ / Схема</th>
      <th>План, шт</th>
      <th>Сдано, шт</th>
      <th style="background:#fff3e0">Сделано, шт</th>
      <th style="background:#ffebee">Брак, шт</th>
      <th>Подпись оператора</th>
    </tr>`;

    linesRows = card.lines
      .map(
        (l, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(l.part_name || "Деталь")}</b>${l.operation_name ? `<div class="sub">${esc(l.operation_name)}</div>` : ""}</td>
      <td class="nw"><b>${esc(l.dimensions)}</b></td>
      <td class="q">${l.strip_width_mm ? `${Math.round(l.strip_width_mm)} мм` : "—"}</td>
      <td>${l.program ? `<code>${esc(l.program)}</code>` : "—"}${l.instruction ? `<div class="warn">⚑ ${esc(l.instruction)}</div>` : ""}</td>
      <td class="q big">${Math.round(l.quantity_pieces)}</td>
      <td class="q">${l.produced_good_pieces ? Math.round(l.produced_good_pieces) : "0"}</td>
      <td class="w"></td>
      <td class="w"></td>
      <td class="w wide"></td>
    </tr>`,
      )
      .join("");
  }

  const materialsTitle = isWrapping
    ? "1. Сырьё и плёнка под наряд"
    : isMilling
      ? "1. Материалы и заготовки МДФ"
      : "1. Сырьё и комплектующие под наряд";

  const qualityMemo = isMilling
    ? "* Регламент ЧПУ: перед запуском всей партии проверьте нулевую точку, траекторию и толщину первого спила штангенциркулем. Проверьте отсутствие сколов по кромке заготовки. Сформировано: " + esc(now) + "."
    : isEdgebanding
      ? "* Регламент кромкооблицовки: проверьте температуру расплава клея и прочность адгезии на пробном метре. Обрезка свесов и радиусная цикля должны быть ровными без ступеней и задиров. Сформировано: " + esc(now) + "."
      : isCarcass
        ? "* Регламент сборки: проверьте диагонали каркаса (разность не более 1.5 мм). Заполнение сотами/пенопластом должно быть плотным, без зазоров по периметру бруска. Сформировано: " + esc(now) + "."
        : "* Регламент качества: перед запуском всей серии проверьте клеевой шов и адгезию на пусковом метре. Размеры заготовки контролируйте поверенным инструментом. При обнаружении дефектов сырья зафиксируйте брак через QR-код наряда. Сформировано: " + esc(now) + ".";

  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Наряд-задание №${card.task_id} — ${esc(card.area_name)}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; margin: 0; padding: 4px; font-size: 11.5px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 10px; }
    .brand { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; font-weight: 600; }
    .title { font-size: 20px; font-weight: 800; margin: 2px 0 4px; color: #000; }
    .subtitle { font-size: 13px; color: #333; }
    .meta-box { display: flex; gap: 16px; font-size: 12px; margin-top: 4px; }
    .meta-item { background: #f4f4f4; padding: 3px 8px; border-radius: 4px; border: 1px solid #ddd; }
    .qr-side { text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .qr-side img { border: 1px solid #ccc; padding: 2px; border-radius: 4px; }
    .qr-text { font-size: 10px; font-family: monospace; font-weight: bold; margin-top: 2px; }

    .note-box { background: #fffbe6; border: 1px solid #ffe58f; padding: 6px 10px; border-radius: 4px; font-size: 11px; margin-bottom: 10px; }
    .note-box b { color: #d48806; }

    h2 { font-size: 13px; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: 0.5px; color: #333; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 10px; }
    th, td { border: 1px solid #888; padding: 4px 6px; text-align: left; vertical-align: middle; }
    th { background: #eaeaea; font-weight: 700; font-size: 10.5px; }
    td.n { width: 20px; text-align: center; color: #666; }
    td.q { text-align: right; white-space: nowrap; }
    td.q.big { font-size: 13px; font-weight: 700; }
    td.nw { white-space: nowrap; }
    td.w { width: 65px; background: #fafafa; }
    td.w.wide { width: 90px; }
    .sub { font-size: 9.5px; color: #666; }
    .warn { font-size: 10px; color: #b35b00; font-weight: 600; }
    .cnc-badge { font-family: monospace; font-size: 11.5px; background: #f0f5ff; border: 1px solid #adc6ff; padding: 2px 6px; border-radius: 3px; display: inline-block; color: #1d39c4; }

    .footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 14px; padding-top: 10px; border-top: 1px solid #aaa; font-size: 11px; }
    .sign-col { flex: 1; }
    .sign-line { border-bottom: 1px solid #444; height: 18px; margin-top: 6px; }
    .memo { font-size: 10px; color: #666; margin-top: 12px; font-style: italic; }

    .bar { position: sticky; top: 0; background: #fff; padding: 8px 12px; border-bottom: 1px solid #ccc; margin-bottom: 10px; display: flex; align-items: center; gap: 12px; }
    .btn-print { background: #1677ff; color: #fff; border: none; padding: 6px 16px; border-radius: 4px; font-weight: 600; cursor: pointer; }
    @media print {
      .bar { display: none; }
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="bar">
    <button class="btn-print" onclick="window.print()">Распечатать наряд (Ctrl+P)</button>
    <span>Наряд-задание №${card.task_id} · ${esc(card.area_name)} · Всего: <b>${card.total_quantity} шт</b></span>
  </div>

  <div class="header">
    <div>
      <div class="brand">Белорусский Дверной Комбинат (БДК) · Производство</div>
      <div class="title">СМЕННЫЙ НАРЯД-ЗАДАНИЕ № ${card.task_id}</div>
      <div class="subtitle">Участок: <b>${esc(card.area_name)}</b> ${card.primary_line_name ? ` · Линия/Станок: <b>${esc(card.primary_line_name)}</b>` : ""}</div>
      <div class="meta-box">
        <div class="meta-item">Заказ: <b>${esc(card.order_name || `№${card.external_order_ref || "—"}`)}</b></div>
        <div class="meta-item">Срок сдачи: <b>${esc(card.deadline_date || "Не указан")}</b></div>
        <div class="meta-item">План: <b>${Math.round(card.total_quantity)} шт</b> · Сдано: <b>${Math.round(card.total_produced_good)} шт</b> (${card.completion_percent}%)</div>
      </div>
    </div>
    <div class="qr-side">
      ${qrDataUrl ? `<img src="${qrDataUrl}" width="90" height="90" alt="QR" />` : renderQrSvg(card.qr_code_value, 90)}
      <div class="qr-text">${esc(card.qr_code_value)}</div>
    </div>
  </div>

  ${
    card.order_note
      ? `<div class="note-box"><b>Примечание к заказу:</b> ${esc(card.order_note)}</div>`
      : ""
  }

  ${
    card.materials.length > 0
      ? `<h2>${materialsTitle}</h2>
  <table>
    <thead>
      <tr>
        <th>№</th>
        <th>Плёнка / Декор / Материал</th>
        <th>Толщина</th>
        <th>Ширина штрипса</th>
        <th>План метраж (+5%)</th>
        <th>Выдано со склада</th>
        <th>Закреплённые рулоны</th>
      </tr>
    </thead>
    <tbody>${materialsRows}</tbody>
  </table>`
      : ""
  }

  <h2>2. Спецификация деталей сменного задания</h2>
  <table>
    <thead>${theadHtml}</thead>
    <tbody>${linesRows}</tbody>
  </table>

  <div class="footer">
    <div class="sign-col">
      Смену выдал (Мастер):
      <div class="sign-line"></div>
    </div>
    <div class="sign-col">
      Задание принял (Оператор):
      <div class="sign-line"></div>
    </div>
    <div class="sign-col">
      Партию проверил и принял (ОТК):
      <div class="sign-line"></div>
    </div>
  </div>

  <div class="memo">${qualityMemo}</div>
</body>
</html>`;

  const w = window.open("", "_blank", "width=1120,height=880");
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
