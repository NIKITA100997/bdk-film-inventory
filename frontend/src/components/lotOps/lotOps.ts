import type { Lot } from "../../api/unifiedStock";
import { skuLabel, type MaterialSku, type MaterialUnit } from "../../api/units";
import type { PartUnit } from "../../api/partUnits";
import { lotNo } from "../../utils/lotNo";

/** Единые окна операций (слой 4 единой модели, 06.10): одно окно на
 * действие для любой партии — рулона/штрипса плёнки или партии п/ф. Таблицы
 * и журналы у видов пока свои; окно само вызывает операцию нужного вида,
 * правила по статусам и правам — те же, что проверяет сервер. */
export type LotOp = "move" | "return" | "writeoff" | "adjust";

/** Партия для окна: строка единых остатков (api/unifiedStock — Lot) или
 * то же, собранное карточкой из рулона / партии п/ф. */
export type LotRef = Pick<Lot, "kind" | "lot_id" | "item_name" | "qty" | "unit" | "status" | "location_code" | "area_name" | "stage" | "detail"> & {
  sku_id?: number | null;
  /** Позиция плёнки целиком — выбор полки с учётом зонирования. */
  sku?: MaterialSku;
  is_strip?: boolean;
  /** Длина рулона по учёту — у выданного рулона qty уже за вычетом расхода. */
  length_m?: number;
};

export const OP_LABEL: Record<LotOp, string> = {
  move: "Переместить",
  return: "Вернуть на склад",
  writeoff: "Списать",
  adjust: "Скорректировать",
};

export const OP_DONE: Record<LotOp, string> = {
  move: "перемещено",
  return: "возвращено на склад",
  writeoff: "списано",
  adjust: "скорректировано",
};

const norm = (s: string) => s.replace(/_/g, " ");

/** Какие операции доступны партии сейчас — по статусу и правам. Причина
 * недоступности — для подсказки на кнопке. */
export function lotOps(lot: LotRef, has: (code: string) => boolean): { op: LotOp; ok: boolean; why?: string }[] {
  const st = norm(lot.status);
  const film = lot.kind === "plenka";
  const written = st === "Списан";
  const perm = (op: LotOp) =>
    film
      ? has({ move: "units.place", return: "units.return", writeoff: "units.writeoff", adjust: "units.correct" }[op])
      : op === "adjust" || op === "return"
        ? has("part_units.correct")
        : has("part_units.manage");
  const rule = (op: LotOp): string | undefined => {
    if (written) return "Партия списана";
    if (op === "move") return film && !["Принят", "На хранении"].includes(st) ? "Разместить можно рулон на хранении" : undefined;
    if (op === "return") return st !== "Выдан участку" ? "Вернуть можно только выданное участку" : undefined;
    if (op === "writeoff") return film && st !== "На хранении" ? "Списать рулон можно только с хранения (выданный — сначала вернуть)" : undefined;
    return undefined;
  };
  return (["move", "return", "writeoff", "adjust"] as LotOp[])
    .filter((op) => perm(op))
    .map((op) => {
      const why = rule(op);
      return { op, ok: !why, why };
    });
}

export const lotTitle = (lot: LotRef) => `${lot.kind === "plenka" ? "Рулон" : "Партия"} ${lotNo(lot.kind, lot.lot_id)}`;

/** Рулон/штрипс плёнки → партия для окна. Остаток — по учёту (у выданного
 * расход по отчётам видно в самом окне возврата). */
export function lotFromUnit(u: MaterialUnit, areaName?: string | null): LotRef {
  return {
    kind: "plenka",
    lot_id: u.id,
    item_name: skuLabel(u.material_sku),
    qty: u.length_m,
    length_m: u.length_m,
    unit: "м",
    status: u.status,
    location_code: u.location_code,
    area_name: areaName ?? u.area,
    stage: null,
    detail: `${u.is_strip ? "штрипс" : "рулон"} ${u.width_mm} мм`,
    sku_id: u.material_sku.id,
    sku: u.material_sku,
    is_strip: u.is_strip,
  };
}

/** Партия п/ф → партия для окна; количество — свободное (за вычетом отчитанного). */
export function lotFromPartUnit(u: PartUnit, areaName?: string | null): LotRef {
  return {
    kind: "pf",
    lot_id: u.id,
    item_name: u.part_name,
    qty: u.quantity_available,
    unit: "шт",
    status: u.status,
    location_code: u.location_code,
    area_name: areaName ?? u.area,
    stage: u.stage_name,
    detail: null,
  };
}
