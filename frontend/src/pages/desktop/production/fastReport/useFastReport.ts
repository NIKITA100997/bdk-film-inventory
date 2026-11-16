import { useEffect, useMemo, useState } from "react";
import { useOpKeys } from "../../../../utils/opKey";
import dayjs from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  closeProductionLine,
  createTaskLineReportsBatch,
  listActiveProductionTasks,
  listProductionLines,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineReportCreate,
} from "../../../../api/production";
import { listPlanSlots } from "../../../../api/planning";
import { areaRequiresRoll, listAreas, type Area, type MasterProfile, type GroupByAttribute } from "../../../../api/areas";
import { listWriteOffReasons } from "../../../../api/writeOffReasons";
import { sendReportWithConfirm } from "../../../../utils/reportConfirm";
import { extractDoorCols, type DoorColsInfo } from "../../../../utils/doorCols";

/** Быстрый отчёт мастера (плитки у станка / таблица в заказе) — общая
 * логика двух видов: какие строки показывать, черновик набранного (живёт на
 * планшете до сохранения), сохранение пачкой — строка за строкой, одна
 * транзакция на строку (как в прежней панели: упала одна — остальные
 * сохранены, упавшая остаётся в черновике). */

export const PUSK_REASON = "puskovye";

export type Disposition = "spisat" | "pererabotka" | "snyat";
export type DefectDraft = { reason: string; qty: number; disposition: Disposition };
// close — «строка сделана полностью»: после отчёта закрыть производство по строке.
// extra — ещё рулоны на эту же строку (другая сторона детали): left — сколько
// метров на нём осталось, null — ещё не ввели (сохранять нельзя).
export type ExtraRoll = { id: number; left: number | null };
// meters — фактический расход плёнки основного рулона, м (прессы, 06.10).
export type Entry = {
  good: string;
  pusk: number;
  defects: DefectDraft[];
  rollId: number | null;
  close?: boolean;
  extra?: ExtraRoll[];
  meters?: number | null;
};
export type FastLine = {
  task: ProductionTask;
  line: ProductionTaskLine;
  onMachine: boolean;
  today: boolean;
  doorInfo: DoorColsInfo;
  groupKey: string;
  groupLabel: string;
};

const EMPTY: Entry = { good: "", pusk: 0, defects: [], rollId: null };

export const filmLabel = (l: ProductionTaskLine) =>
  l.material ? `${l.material} ${l.color ?? ""} ${l.thickness ?? ""}`.replace(/\s+/g, " ").trim() : "без плёнки";

export function resolveAreaProfile(areaObj?: Area | null, areaCode?: string): MasterProfile {
  if (areaObj?.master_profile && areaObj.master_profile !== "auto") {
    return areaObj.master_profile;
  }
  const code = (areaCode || areaObj?.code || "").toLowerCase();
  const name = (areaObj?.name || "").toLowerCase();
  const s = `${code} ${name}`;
  if (
    s.includes("okutka") ||
    s.includes("окутк") ||
    s.includes("ламинац") ||
    s.includes("шпон") ||
    s.includes("пресс") ||
    s.includes("пленк") ||
    s.includes("плёнк")
  ) {
    return "wrapping";
  }
  if (
    s.includes("frez") ||
    s.includes("фрез") ||
    s.includes("чпу") ||
    s.includes("raskroy") ||
    s.includes("раскрой") ||
    s.includes("порезк")
  ) {
    return "milling";
  }
  if (s.includes("kromk") || s.includes("кромк") || s.includes("облицов")) {
    return "edgebanding";
  }
  if (
    s.includes("sbork") ||
    s.includes("сборк") ||
    s.includes("каркас") ||
    s.includes("полотен") ||
    s.includes("склейк") ||
    s.includes("щит")
  ) {
    return "assembly";
  }
  if (
    s.includes("upakov") ||
    s.includes("упаков") ||
    s.includes("отк") ||
    s.includes("паллет") ||
    s.includes("комплект")
  ) {
    return "packaging";
  }
  return "universal";
}

export function resolveGroupBy(areaObj?: Area | null, profile?: MasterProfile): GroupByAttribute {
  if (areaObj?.group_by_attribute && areaObj.group_by_attribute !== "auto") {
    return areaObj.group_by_attribute;
  }
  switch (profile) {
    case "wrapping":
      return "film";
    case "milling":
      return "program";
    case "edgebanding":
      return "edge";
    case "assembly":
      return "dimensions";
    case "packaging":
      return "order";
    default:
      return "none";
  }
}

export function getLineGroup(
  line: ProductionTaskLine,
  task: ProductionTask,
  doorInfo: DoorColsInfo,
  groupBy: GroupByAttribute,
): { key: string; label: string } {
  if (line.group_key && line.group_label) {
    return { key: line.group_key, label: line.group_label };
  }
  switch (groupBy) {
    case "film":
      if (line.material) {
        return {
          key: `film:${line.material}_${line.color ?? ""}_${line.thickness ?? ""}`.trim(),
          label: filmLabel(line),
        };
      }
      return { key: "film:none", label: "Без плёнки" };

    case "program":
      if (line.program) {
        return {
          key: `prog:${line.program}`,
          label: `Программа ЧПУ: ${line.program}`,
        };
      }
      return { key: "prog:manual", label: "Без программы (ручная обработка)" };

    case "edge":
      if (doorInfo.edge_label) {
        return {
          key: `edge:${doorInfo.edge_label}`,
          label: `Кромка: ${doorInfo.edge_label}`,
        };
      }
      if (doorInfo.edge_type) {
        const lbl = `Кромка: ${doorInfo.edge_type} ${doorInfo.edge_color ?? ""}`.trim();
        return { key: `edge:${lbl}`, label: lbl };
      }
      return { key: "edge:none", label: "Без кромки" };

    case "series":
      if (doorInfo.series) {
        return {
          key: `series:${doorInfo.series}`,
          label: `Серия: ${doorInfo.series}`,
        };
      }
      if (doorInfo.dimensions_str) {
        return {
          key: `dim:${doorInfo.dimensions_str}`,
          label: `Размер: ${doorInfo.dimensions_str}`,
        };
      }
      return { key: "series:other", label: line.part_name || "Остальные серии" };

    case "thickness": {
      const thVal = line.thickness != null ? String(line.thickness) : null;
      const thMatch =
        thVal ||
        doorInfo.dimensions_str.match(/×\s*(\d+(?:[.,]\d+)?)\s*мм/)?.[1];
      if (thMatch) {
        return {
          key: `th:${thMatch}`,
          label: `Толщина: ${thMatch} мм`,
        };
      }
      return { key: "th:std", label: "Стандартная толщина" };
    }

    case "dimensions": {
      const dim =
        doorInfo.dimensions_str ||
        (line.part_name?.match(/(\d+(?:[.,]\d+)?\s*[хxXХ*×]\s*\d+(?:\s*[хxXХ*×]\s*\d+)?)/)?.[1]?.replace(/\s+/g, "") ?? "");
      if (dim) {
        return {
          key: `dim:${dim}`,
          label: `Размер: ${dim}`,
        };
      }
      return { key: "dim:other", label: line.part_name || "Различные размеры" };
    }

    case "order": {
      const ordName = task.production_order_name ?? task.name ?? `Задание №${task.id}`;
      return {
        key: `ord:${task.production_order_id ?? task.id}`,
        label: `Заказ: ${ordName}`,
      };
    }

    case "none":
    default:
      return { key: "all", label: "Все позиции" };
  }
}

export type RollChoice = { id: number; width_mm: number; left: number; from: string | null };

/** Рулоны, которые можно указать в отчёте по строке: выданные на неё и
 * общие рулоны участка (выданы под другое задание в той же плёнке и
 * подходящей ширине — backend: borrowable_units). */
export const rollChoices = (l: ProductionTaskLine): RollChoice[] => [
  ...l.issued_units
    .filter((u) => u.status === "Выдан_участку")
    .map((u) => ({ id: u.id, width_mm: u.width_mm, left: u.remaining_length_m ?? u.length_m, from: null })),
  ...(l.borrowable_units ?? [])
    .filter((u) => (u.remaining_length_m ?? 0) > 0)
    .map((u) => ({ id: u.id, width_mm: u.width_mm, left: u.remaining_length_m ?? u.length_m, from: u.from_part_name ?? "другое задание" })),
];

/** Рулон по умолчанию: свой последний выданный, иначе общий рулон участка
 * с наибольшим остатком. */
export const defaultRoll = (l: ProductionTaskLine): number | null => {
  const all = rollChoices(l);
  const own = all.filter((r) => r.from === null);
  if (own.length) return own.reduce((a, b) => (b.id > a.id ? b : a)).id;
  if (all.length) return all.reduce((a, b) => (b.left > a.left ? b : a)).id;
  return null;
};

export const isFilled = (e: Entry | undefined) => !!e && (+e.good > 0 || e.pusk > 0 || e.defects.length > 0 || !!e.close);

/** «Мой набор» — строки, отмеченные мастером на смену (★), по участку. */
export const pinsKey = (area: string) => `fast-report-pins:${area}`;
export function loadPins(area: string): number[] {
  try {
    const raw = localStorage.getItem(pinsKey(area));
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

function loadDraft(key: string): Record<number, Entry> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Своя линия мастера на участке (06.10, «Ежедневка» по линиям) — одна на
 * планшет и участок, уходит с каждым отчётом. */
const lineKey = (area: string) => `fast-report-line:${area}`;
function loadLine(area: string): number | null {
  try {
    const v = Number(localStorage.getItem(lineKey(area)));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function useFastReport({ area, orderId, taskId }: { area: string; orderId?: number; taskId?: number }) {
  const qc = useQueryClient();
  const draftKey = `fast-report:${area}:${taskId != null ? `t${taskId}` : (orderId ?? "all")}`;
  const [entries, setEntries] = useState<Record<number, Entry>>(() => loadDraft(draftKey));
  useEffect(() => setEntries(loadDraft(draftKey)), [draftKey]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(entries));
    } catch {
      /* без хранилища черновик живёт до закрытия вкладки */
    }
  }, [draftKey, entries]);

  const tasksQuery = useQuery({ queryKey: ["production-tasks", "active"], queryFn: listActiveProductionTasks });
  const today = dayjs().format("YYYY-MM-DD");
  const slotsQuery = useQuery({
    queryKey: ["plan-slots", area, today, "fast"],
    queryFn: () => listPlanSlots({ area, date_from: today, date_to: today, include_earlier: true }),
  });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "production"], queryFn: () => listWriteOffReasons("production") });
  const partsReasonsQuery = useQuery({ queryKey: ["write-off-reasons", "parts"], queryFn: () => listWriteOffReasons("parts") });
  const reasons = useMemo(
    () =>
      [...(reasonsQuery.data ?? []), ...(partsReasonsQuery.data ?? [])].filter(
        (r, i, arr) => r.is_active !== false && arr.findIndex((x) => x.code === r.code) === i,
      ),
    [reasonsQuery.data, partsReasonsQuery.data],
  );

  const areaObj = areasQuery.data?.find((a) => a.code === area);
  const profile = resolveAreaProfile(areaObj, area);
  const groupBy = resolveGroupBy(areaObj, profile);

  const showDimensions = areaObj?.show_dimensions ?? true;
  const showCnc = areaObj?.show_cnc_program ?? (profile === "milling");
  const showEdge = areaObj?.show_edge_specs ?? (profile === "edgebanding");
  const hasPusk =
    areaObj?.has_pusk_pieces ??
    (profile === "wrapping" && reasons.some((r) => r.code === PUSK_REASON));
  const requiresRoll = areaRequiresRoll(areasQuery.data, area);
  // Плёнку режут на участке (прессы): мастер вводит штуки и сколько метров
  // ушло — средний расход на панель программа считает сама (06.10).
  const filmByMeters = !!areaObj?.film_cut_on_site;

  const todayLines = useMemo(() => new Set((slotsQuery.data ?? []).map((s) => s.task_line_id)), [slotsQuery.data]);
  const lines: FastLine[] = useMemo(() => {
    const out: FastLine[] = [];
    for (const task of tasksQuery.data ?? []) {
      if (task.area !== area || !task.is_active) continue;
      if (orderId != null && task.production_order_id !== orderId) continue;
      if (taskId != null && task.id !== taskId) continue;
      for (const line of task.lines) {
        if (line.production_closed) continue;
        // Без плёнки (п/ф: распил, склейка, фрезеровка) рулонов нет — такая строка всегда «в работе».
        const onMachine = line.material === null || rollChoices(line).length > 0;
        const doorInfo = extractDoorCols(
          line.item_chars,
          line.part_name,
          line.length_m,
          line.width_mm,
          line.thickness != null ? Number(line.thickness) : null,
        );
        const { key: groupKey, label: groupLabel } = getLineGroup(line, task, doorInfo, groupBy);
        out.push({
          task,
          line,
          onMachine,
          today: todayLines.has(line.id),
          doorInfo,
          groupKey,
          groupLabel,
        });
      }
    }
    return out;
  }, [tasksQuery.data, area, orderId, taskId, todayLines, groupBy]);

  const entryOf = (l: ProductionTaskLine): Entry => {
    const e = entries[l.id];
    return e ? { ...EMPTY, ...e } : { ...EMPTY, rollId: defaultRoll(l) };
  };
  const setEntry = (l: ProductionTaskLine, patch: Partial<Entry>) =>
    setEntries((prev) => ({ ...prev, [l.id]: { ...entryOf(l), ...prev[l.id], ...patch } }));
  const clearEntry = (lineId: number) =>
    setEntries((prev) => {
      const next = { ...prev };
      delete next[lineId];
      return next;
    });

  const filled = lines.filter((fl) => isFilled(entries[fl.line.id]));

  const [pinList, setPinList] = useState<number[]>(() => loadPins(area));
  useEffect(() => setPinList(loadPins(area)), [area]);
  useEffect(() => {
    try {
      localStorage.setItem(pinsKey(area), JSON.stringify(pinList));
    } catch {
      /* без хранилища набор живёт до закрытия вкладки */
    }
  }, [area, pinList]);
  // Закрытые/ушедшие строки сами выпадают из набора.
  useEffect(() => {
    if (tasksQuery.isLoading || !tasksQuery.data || orderId != null || taskId != null) return;
    const alive = new Set(lines.map((fl) => fl.line.id));
    setPinList((p) => (p.every((id) => alive.has(id)) ? p : p.filter((id) => alive.has(id))));
  }, [lines, tasksQuery.isLoading, tasksQuery.data, orderId, taskId]);
  const pins = useMemo(() => new Set(pinList), [pinList]);
  const togglePin = (lineId: number) => setPinList((p) => (p.includes(lineId) ? p.filter((x) => x !== lineId) : [...p, lineId]));
  const clearPins = () => setPinList([]);
  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });
  const areaLines = useMemo(
    () => (linesQuery.data ?? []).filter((l) => l.area === area && l.is_active),
    [linesQuery.data, area],
  );
  const [myLine, setMyLineState] = useState<number | null>(() => loadLine(area));
  useEffect(() => setMyLineState(loadLine(area)), [area]);
  const setMyLine = (id: number | null) => {
    setMyLineState(id);
    try {
      if (id) localStorage.setItem(lineKey(area), String(id));
      else localStorage.removeItem(lineKey(area));
    } catch {
      /* без хранилища — до перезагрузки */
    }
  };
  // линия есть, только если она этого участка (участок у планшета могли сменить)
  const lineForReport = myLine && areaLines.some((l) => l.id === myLine) ? myLine : null;
  const needsRoll = (fl: FastLine) => requiresRoll && fl.line.material !== null && !entryOf(fl.line).rollId;

  const opKeys = useOpKeys();
  const save = useMutation({
    mutationFn: async () => {
      const settled = await Promise.allSettled(
        filled.map(async (fl) => {
          const e = entryOf(fl.line);
          const roll = e.rollId;
          const payloads: ProductionTaskLineReportCreate[] = [];
          if (+e.good > 0) payloads.push({ assignment_id: null, material_unit_id: roll, good_pieces: +e.good, defect_pieces: 0 });
          if (e.pusk > 0) {
            payloads.push({
              assignment_id: null, material_unit_id: roll, good_pieces: 0, defect_pieces: e.pusk,
              defect_reason: PUSK_REASON, defect_disposition: "spisat",
            });
          }
          for (const d of e.defects) {
            payloads.push({
              assignment_id: null, material_unit_id: roll, good_pieces: 0, defect_pieces: d.qty,
              defect_reason: d.reason, defect_disposition: d.disposition,
            });
          }
          // Фактический расход основного рулона — на первую запись, на
          // остальные (брак) — 0, иначе брак посчитается ещё и по норме.
          if (filmByMeters && e.meters != null && fl.line.material !== null) {
            payloads.forEach((pl, i) => (pl.film_used_m = i === 0 ? e.meters : 0));
          }
          // Ещё рулоны (как в подробном отчёте): те же детали, расход — из
          // остатка, который ввёл мастер; counts_toward_line=false — не задваивать план.
          for (const x of e.extra ?? []) {
            const u = rollChoices(fl.line).find((c) => c.id === x.id);
            const consumed = Math.max(0, (u?.left ?? 0) - (x.left ?? u?.left ?? 0));
            payloads.push({
              assignment_id: null, material_unit_id: x.id,
              good_pieces: fl.line.length_m > 0 ? consumed / fl.line.length_m : 0, defect_pieces: 0,
              counts_toward_line: false, note: `Остаток указан вручную: ${x.left} м`, kind: "remainder",
              used_up: x.left === 0,
            });
          }
          if (lineForReport) for (const pl of payloads) pl.line_id = lineForReport;
          if (payloads.length)
            await sendReportWithConfirm((confirmed) =>
              createTaskLineReportsBatch(fl.task.id, fl.line.id, payloads.map((p) => ({ ...p, confirmed })), opKeys.get(String(fl.line.id))),
            );
          if (e.close) await closeProductionLine(fl.task.id, fl.line.id, true);
          return fl.line.id;
        }),
      );
      return settled;
    },
    onSuccess: (settled) => {
      for (const s of settled)
        if (s.status === "fulfilled") {
          clearEntry(s.value);
          opKeys.done(String(s.value));
        }
      for (const k of [["production-tasks"], ["production-orders"], ["part-units"], ["plan-board"]]) qc.invalidateQueries({ queryKey: k });
    },
  });

  return {
    areaObj,
    profile,
    groupBy,
    showDimensions,
    showCnc,
    showEdge,
    areaLines,
    myLine: lineForReport,
    setMyLine,
    loading: tasksQuery.isLoading,
    lines,
    entryOf,
    setEntry,
    clearEntry,
    filled,
    needsRoll,
    save,
    pins,
    togglePin,
    clearPins,
    reasons,
    hasPusk,
    requiresRoll,
    filmByMeters,
  };
}

/** Средний расход на панель: метры (с браком) на годную и на все панели. */
export function metersPerPanel(meters: number, good: number, defect: number) {
  return {
    perGood: good > 0 ? meters / good : null,
    perAll: good + defect > 0 ? meters / (good + defect) : null,
  };
}
