import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTaskLineReportsBatch,
  listProductionTasks,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineReportCreate,
} from "../../../../api/production";
import { listPlanSlots } from "../../../../api/planning";
import { areaRequiresRoll, listAreas } from "../../../../api/areas";
import { listWriteOffReasons } from "../../../../api/writeOffReasons";

/** Быстрый отчёт мастера (плитки у станка / таблица в заказе) — общая
 * логика двух видов: какие строки показывать, черновик набранного (живёт на
 * планшете до сохранения), сохранение пачкой — строка за строкой, одна
 * транзакция на строку (как в прежней панели: упала одна — остальные
 * сохранены, упавшая остаётся в черновике). */

export const PUSK_REASON = "puskovye";

export type Disposition = "spisat" | "pererabotka" | "snyat";
export type DefectDraft = { reason: string; qty: number; disposition: Disposition };
export type Entry = { good: string; pusk: number; defects: DefectDraft[]; rollId: number | null };
export type FastLine = { task: ProductionTask; line: ProductionTaskLine; onMachine: boolean; today: boolean };

const EMPTY: Entry = { good: "", pusk: 0, defects: [], rollId: null };

export const filmLabel = (l: ProductionTaskLine) =>
  l.material ? `${l.material} ${l.color ?? ""} ${l.thickness ?? ""}`.replace(/\s+/g, " ").trim() : "без плёнки";

/** Рулон по умолчанию: единственный выданный — он; несколько — последний выданный. */
export const defaultRoll = (l: ProductionTaskLine): number | null => {
  const issued = l.issued_units.filter((u) => u.status === "Выдан_участку");
  if (issued.length === 0) return null;
  return issued.reduce((a, b) => (b.id > a.id ? b : a)).id;
};

export const isFilled = (e: Entry | undefined) => !!e && (+e.good > 0 || e.pusk > 0 || e.defects.length > 0);

function loadDraft(key: string): Record<number, Entry> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function useFastReport({ area, orderId }: { area: string; orderId?: number }) {
  const qc = useQueryClient();
  const draftKey = `fast-report:${area}:${orderId ?? "all"}`;
  const [entries, setEntries] = useState<Record<number, Entry>>(() => loadDraft(draftKey));
  useEffect(() => setEntries(loadDraft(draftKey)), [draftKey]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(entries));
    } catch {
      /* без хранилища черновик живёт до закрытия вкладки */
    }
  }, [draftKey, entries]);

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
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
  const hasPusk = reasons.some((r) => r.code === PUSK_REASON);
  const requiresRoll = areaRequiresRoll(areasQuery.data, area);

  const todayLines = useMemo(() => new Set((slotsQuery.data ?? []).map((s) => s.task_line_id)), [slotsQuery.data]);
  const lines: FastLine[] = useMemo(() => {
    const out: FastLine[] = [];
    for (const task of tasksQuery.data ?? []) {
      if (task.area !== area || !task.is_active) continue;
      if (orderId != null && task.production_order_id !== orderId) continue;
      for (const line of task.lines) {
        if (line.production_closed) continue;
        const onMachine = line.issued_units.some((u) => u.status === "Выдан_участку");
        out.push({ task, line, onMachine, today: todayLines.has(line.id) });
      }
    }
    return out;
  }, [tasksQuery.data, area, orderId, todayLines]);

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
  const needsRoll = (fl: FastLine) => requiresRoll && fl.line.material !== null && !entryOf(fl.line).rollId;

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
          await createTaskLineReportsBatch(fl.task.id, fl.line.id, payloads);
          return fl.line.id;
        }),
      );
      return settled;
    },
    onSuccess: (settled) => {
      for (const s of settled) if (s.status === "fulfilled") clearEntry(s.value);
      for (const k of [["production-tasks"], ["production-orders"], ["part-units"], ["plan-board"]]) qc.invalidateQueries({ queryKey: k });
    },
  });

  return {
    loading: tasksQuery.isLoading,
    lines,
    entryOf,
    setEntry,
    clearEntry,
    filled,
    needsRoll,
    save,
    reasons,
    hasPusk,
    requiresRoll,
  };
}
