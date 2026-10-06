import { useEffect } from "react";
import {
  Typography,
} from "antd";
import {
  type MaterialSku,
} from "../../../api/units";
import { suggestLocation } from "../../../api/storage";
import { rollNo } from "../../../utils/lotNo";
import { type CuttingBatchEntry, type StockDecision, type RowInfo, type QueueRowData, useGroupCuttingPlan } from "./model";

/** "Невидимый" репортёр — один экземпляр на группу, смонтирован ВСЕГДА
 * (не только когда строка развёрнута), чтобы и колонка "Статус", и
 * колонка "Действия" в таблице знали актуальное состояние каждой строки
 * без необходимости её открывать — кнопки "Использовать"/"+ В резку"
 * нужны прямо в строке, не только в развороте. Сам ничего не рендерит —
 * пишет результат (статус + готовые к вызову действия) в общий стейт
 * lineInfoMap в Issue(). */
export function GroupStatusReporter({
  sku,
  rows,
  onAddToBatch,
  onAddStockDecision,
  onReport,
}: {
  sku: MaterialSku | undefined;
  rows: QueueRowData[];
  onAddToBatch: (entry: CuttingBatchEntry) => void;
  onAddStockDecision: (decision: StockDecision) => void;
  onReport: (infos: Map<number, RowInfo>) => void;
}) {
  const planQuery = useGroupCuttingPlan(sku, rows);
  useEffect(() => {
    if (!planQuery.data || !sku) return;
    const data = planQuery.data;
    const infos = new Map<number, RowInfo>();
    const coveredRows = data.donor ? data.covered_indices.map((i) => rows[i]) : [];
    const acceptCut = data.donor
      ? async () => {
          const donor = data.donor!;
          const remainderLocationCode = (await suggestLocation({ material_sku_id: sku.id, is_strip: true })) ?? undefined;
          onAddToBatch({
            donorUnitId: donor.unit_id,
            donorWidthMm: donor.width_mm,
            donorLengthM: donor.length_m,
            wasteMm: data.waste_mm,
            remainderLocationCode,
            pieces: coveredRows.map((r) => ({
              widthMm: r.line.strip_width_mm || r.line.width_mm,
              label: r.line.part_name ?? "Деталь",
              area: r.task.area,
              productionTaskLineId: r.line.id,
            })),
          });
        }
      : undefined;
    rows.forEach((r, i) => {
      const stockMatch = data.stock_matches.find((m) => m.index === i);
      if (stockMatch) {
        infos.set(r.line.id, {
          status: { kind: "stock", match: stockMatch },
          acceptStock: () =>
            onAddStockDecision({
              lineId: r.line.id,
              unitId: stockMatch.unit_id,
              area: r.task.area,
              label: r.line.part_name ?? "Деталь",
              widthMm: stockMatch.width_mm,
            }),
        });
      } else if (data.donor && data.covered_indices.includes(i)) {
        infos.set(r.line.id, { status: { kind: "cut_planned" }, donorUnitId: data.donor.unit_id, acceptCut });
      } else {
        infos.set(r.line.id, { status: { kind: "no_donor" } });
      }
    });
    onReport(infos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planQuery.data]);
  return null;
}

/** Панель решения — доп. контекст в развороте строки (полный план: какой
 * донор, что покрыто/не покрыто, отход) — сами кнопки действий теперь
 * живут в колонке таблицы (переиспользуют тот же lineInfoMap), здесь
 * только текст-сводка + ссылка на ручной подбор. Тот же запрос, что и у
 * репортёра — cutting-plan уже в кэше, повторного похода на бэкенд нет. */
export function GroupDecisionPanel({
  sku,
  rows,
  onOpenManualPicker,
  cutOnSite = false,
}: {
  sku: MaterialSku | undefined;
  rows: QueueRowData[];
  onOpenManualPicker: () => void;
  // Участок режет плёнку сам (прессы): выдаётся рулон целиком, не штрипс.
  cutOnSite?: boolean;
}) {
  const planQuery = useGroupCuttingPlan(sku, rows);
  const manualLink = <a onClick={onOpenManualPicker}>🔧 Свой донор и раскрой</a>;

  if (!sku || !planQuery.data) return <Typography.Text type="secondary">Подбираем план резки…</Typography.Text>;
  const { donor, covered_widths_mm, uncovered_widths_mm, waste_mm } = planQuery.data;

  if (cutOnSite) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12.5, display: "block" }}>
        🧻 Участок режет плёнку сам — выдаётся рулон целиком (не уже детали), без резки на складе.
        {uncovered_widths_mm.length > 0 && " Подходящего рулона этой плёнки на складе нет."}
        {" · "}
        {manualLink}
      </Typography.Text>
    );
  }

  if (!donor) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12.5, display: "block" }}>
        {uncovered_widths_mm.length > 0 && "✂️ Подходящего донора для резки на оставшиеся ширины среди остатков нет — резать новый рулон."}
        {" · "}
        {manualLink}
      </Typography.Text>
    );
  }

  return (
    <Typography.Text type="secondary" style={{ fontSize: 12.5, display: "block" }}>
      ✂️ План резки: донор {rollNo(donor.unit_id)} ({donor.width_mm} мм, {donor.length_m} м) → режем{" "}
      {covered_widths_mm.join(" + ")} мм, отход {waste_mm} мм
      {uncovered_widths_mm.length > 0 && <> · ещё нет донора на {uncovered_widths_mm.join(", ")} мм</>}
      {" · "}
      {manualLink}
    </Typography.Text>
  );
}
