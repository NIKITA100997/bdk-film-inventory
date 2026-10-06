import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import {
  getCuttingPlan,
  type AreaValue,
  type CuttingPlanStockMatch,
  type MaterialSku,
  type MaterialUnit,
} from "../../../api/units";
import {
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineAssignment,
} from "../../../api/production";


export function issueErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

// Раздел про единую форму резки — донор для CuttingForm нужен как
// MaterialUnit целиком (адрес ячейки/статус/номенклатура), а результат
// поиска донора (DonorSuggestion/план резки) несёт только часть этих
// полей — остальное довоссоздаём из уже известного контекста (sku уже
// выбранной номенклатуры, статус донора всегда "На хранении" — иначе он
// не попал бы в подсказку донора вообще).
export function makeDonorUnit(unitId: number, widthMm: number, lengthM: number, warehouseName: string | null, sku: MaterialSku): MaterialUnit {
  return {
    id: unitId,
    parent_id: null,
    upd_number: "",
    pallet_number: "",
    material_sku: sku,
    width_mm: widthMm,
    length_m: lengthM,
    is_strip: false,
    status: "На_хранении",
    area: null,
    location_code: null,
    production_task_line_id: null,
    legacy_task_note: null,
    area_m2: Math.round(((widthMm * lengthM) / 1000) * 1000) / 1000,
    warehouse_name: warehouseName,
  };
}

// Раздел про разбор задания единой таблицей — одна запись = один уже
// подобранный (авто или вручную) донор из группового плана резки
// (/units/cutting-plan), ещё НЕ разрезанный физически; pieces — какие
// ширины из него резать и для какой детали/задания/участка, то же самое,
// что уже строит CuttingForm как widthCuts. Раньше это был только план
// для печати ("Список на резку"), решение о самой резке принималось
// отдельно кнопкой "Резать"; теперь запись в этом батче — это и есть
// решение (по каждой строке принимается один раз здесь), а печать и
// реальное выполнение ("Выполнить всё") оба читают из одного и того же
// списка — pieces поэтому несут все данные, нужные execute_cutting_recipe
// (area/productionTaskLineId/actualLengthM), не только для печати.
export interface CuttingBatchEntry {
  donorUnitId: number;
  donorWidthMm: number;
  donorLengthM: number;
  wasteMm: number;
  // Ячейка для окончательного остатка донора после всех резов — подобрана
  // заранее (suggestLocation, чистое превью) в момент постановки в батч,
  // чтобы печатный список мог её показать ещё до выполнения.
  remainderLocationCode?: string;
  pieces: { widthMm: number; label: string; area: AreaValue; productionTaskLineId?: number }[];
}

// Раздел про разбор задания единой таблицей — решение "выдать со склада"
// по строке, у которой нашлось точное совпадение (stock_matches из
// /units/cutting-plan) — накапливается так же, как cuttingBatch, до
// нажатия "Выполнить всё" (issueUnitDirect по каждой записи).
export interface StockDecision {
  lineId: number;
  unitId: number;
  area: AreaValue;
  label: string;
  widthMm: number;
}

// Статус одной строки очереди (раздел про разбор задания единой таблицей)
// — вместо того, чтобы строка молча показывала только сырые цифры
// нехватки, теперь видно сразу: уже выдано (и в каком состоянии — на
// участке / едет через хаб / принято на другом складе, но не довыдано
// локально), есть точное совпадение на складе, входит в план резки, нет
// донора вообще, или по ней уже принято решение (ждёт "Выполнить всё").
export type RowStatus =
  | { kind: "issued"; note: string }
  | { kind: "stock"; match: CuttingPlanStockMatch }
  | { kind: "cut_planned" }
  | { kind: "no_donor" }
  | { kind: "decided" };

// Раздел про кнопки действий прямо в строке (не только в развороте) —
// статус для колонки "Статус" + готовые к вызову действия для колонки
// "Действия", посчитанные один раз репортёром группы (GroupStatusReporter)
// и переиспользуемые и таблицей, и панелью решения в развороте.
export interface RowInfo {
  status: RowStatus;
  donorUnitId?: number; // для проверки batchedDonorIds у кнопки "+ В резку"
  acceptStock?: () => void;
  acceptCut?: () => Promise<void>;
}

// Раздел про фильтр по статусу — та же категория, что уже показывает
// пилюля в колонке "Статус" (renderStatusPill) и иконки в "Действиях",
// просто с явным именем для выбора в Select. "manual"/"issued" — не из
// RowStatus (там это разные независимые сигналы — issuedNoteForLine и
// kind === "manual" у самой строки), а посчитаны заново в rowStatusKind
// ниже, чтобы фильтр совпадал буквально с тем, что видно в таблице.
export type StatusFilterValue = "issued" | "stock" | "cut" | "no_donor" | "decided" | "manual";

export const statusFilterOptions: { value: StatusFilterValue; label: string }[] = [
  { value: "no_donor", label: "✖ Нет донора" },
  { value: "cut", label: "✂️ План резки" },
  { value: "stock", label: "✅ Есть на складе" },
  { value: "decided", label: "🕒 Решено" },
  { value: "issued", label: "✅ Выдано" },
  { value: "manual", label: "✅ Вручную" },
];

// Раздел про разбор задания единой таблицей — одна строка плотной
// таблицы: либо нужда/выдача по строке задания ("need"), либо единица,
// выданная без привязки к заданию ("manual", раньше отдельная таблица
// "Выдано вручную" внизу экрана).
export interface NeedTableRow {
  kind: "need";
  key: string;
  task: ProductionTask;
  line: ProductionTaskLine;
  assignment?: ProductionTaskLineAssignment;
  overdue?: boolean;
  variant: "today" | "week";
}
export interface ManualTableRow {
  kind: "manual";
  key: string;
  unit: MaterialUnit;
}
export type TableRow = NeedTableRow | ManualTableRow;

export function findSku(skus: MaterialSku[] | undefined, material: string | null, color: string | null, thickness: number | null) {
  if (material === null || color === null || thickness === null) return undefined; // строка без плёнки
  return skus?.find(
    (s) =>
      s.material.name.toLowerCase() === material.toLowerCase() &&
      s.color.name.toLowerCase() === color.toLowerCase() &&
      Math.abs(s.thickness.value_mm - thickness) < 0.01,
  );
}

export interface IssuePrefill {
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
}

export interface QueueSelection {
  task: ProductionTask;
  line: ProductionTaskLine;
  assignment?: ProductionTaskLineAssignment;
}

export type QueueRowData = { task: ProductionTask; line: ProductionTaskLine; assignment?: ProductionTaskLineAssignment; overdue?: boolean };

/** Сколько метров плёнки реально нужно под ОДНУ строку очереди (раздел про
 * общий погонаж партии деталей, не длину одной детали) — "сегодня"-строка
 * привязана к конкретной бригаде/линии на день (assignment), ей нужен один
 * штрипс на ЕЁ количество на сегодня; параллельные бригады на ту же строку
 * задания — это отдельные assignment-записи и отдельные строки очереди
 * (groupQueueRows их не схлопывает), каждая посчитает свою длину сама, так
 * что "3 бригады параллельно = 3 отдельных штрипса" получается само собой,
 * без специальной логики. "Неделя"-строка (ещё не распределено по
 * бригадам) — весь оставшийся долг строки одним куском (shortfall_length_m,
 * его можно будет разрезать на месте по длине под нужное число бригад,
 * когда распределение появится). */
export function neededLengthM(row: QueueRowData): number {
  return row.assignment ? row.assignment.quantity_pieces * row.line.length_m : row.line.shortfall_length_m;
}

/** Одна и та же плёнка на нескольких заданиях участка, независимо от
 * ширины штрипса (раздел про объединение требований + план резки на
 * несколько разных ширин) — раньше на очереди выдачи это были никак не
 * связанные строки, хотя по факту это один и тот же рулон, который можно
 * резать под несколько заданий сразу. Группировка по плёнке (без ширины
 * в ключе) — щелевая резка режет донора на несколько разных ширин за
 * один проход, поэтому даже разноширинные потребности одной плёнки
 * выгодно резать вместе (см. CuttingPlanHint ниже). Сама выдача
 * остаётся построчной (каждая линия — свой список/своя точная длина). */
export function groupQueueRows(rows: QueueRowData[]) {
  const order: string[] = [];
  const groups = new Map<string, { key: string; material: string; color: string; thickness: number; rows: QueueRowData[] }>();
  for (const r of rows) {
    const key = `${r.task.area}|${r.line.material}|${r.line.color}|${r.line.thickness}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, material: r.line.material ?? "", color: r.line.color ?? "", thickness: r.line.thickness ?? 0, rows: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.rows.push(r);
  }
  return order.map((k) => groups.get(k)!);
}

/** Подсказка плана резки для группы разноширинных потребностей одной
 * плёнки (раздел про несколько разных ширин штрипса на один день) —
 * щелевая резка режет донора на несколько полос за проход, так что вместо
 * резки каждой линии отдельно от своего донора выгоднее резать один
 * донор сразу под несколько нужных ширин. "Взять в работу" открывает
 * форму, которая режет и выдаёт все покрытые строки одним действием (см.
 * CuttingPlanExecuteModal) — план и выдача больше не два независимых
 * потока: строки, которых план не покрыл (uncovered), по-прежнему идут
 * через обычный клик по строке (независимый одноширинный подбор). */
/** Общий запрос плана резки на группу строк одной плёнки+участка (раздел
 * про разбор задания единой таблицей) — один и тот же queryKey/queryFn у
 * "невидимого" статус-репортёра (см. GroupStatusReporter) и у панели
 * решения внутри разворота строки (см. GroupDecisionPanel), чтобы второй
 * не делал повторный сетевой запрос — react-query отдаёт его из кэша
 * первого. Вызывается единообразно для ЛЮБОГО размера группы, включая
 * группы из одной строки (backend/app/api/units.py::get_cutting_plan сам
 * применяет ABC-осторожность именно в этом случае). */
export function useGroupCuttingPlan(sku: MaterialSku | undefined, rows: QueueRowData[]) {
  const widths = rows.map((r) => r.line.strip_width_mm || r.line.width_mm);
  const lengths = rows.map((r) => neededLengthM(r));
  return useQuery({
    queryKey: [
      "cutting-plan",
      sku?.material.name,
      sku?.color.name,
      sku?.thickness.value_mm,
      sku?.manufacturer.name,
      widths.join(","),
      lengths.join(","),
      rows[0]?.task.area,
    ],
    queryFn: () =>
      getCuttingPlan({
        material: sku!.material.name,
        color: sku!.color.name,
        thickness: sku!.thickness.value_mm,
        manufacturer: sku!.manufacturer.name,
        needed_widths_mm: widths,
        needed_lengths_m: lengths,
        area: rows[0]?.task.area,
      }),
    enabled: !!sku,
  });
}

export interface IssuedResult {
  unit: MaterialUnit;
  remainder: MaterialUnit | null;
  remainderPlaced: boolean;
}
