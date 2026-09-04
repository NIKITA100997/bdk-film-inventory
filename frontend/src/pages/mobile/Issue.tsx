import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import Statistic from "../../components/Statistic";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import dayjs, { type Dayjs } from "dayjs";
import { toOccurredAtIso } from "../../utils/occurredAt";
import { printReport } from "../../utils/printReport";
import {
  getCuttingPlan,
  getReturnPreview,
  issueUnit,
  issueUnitDirect,
  placeUnit,
  printLabel,
  printLabelsBatch,
  returnUnit,
  searchUnits,
  skuLabel,
  executeCuttingRecipe,
  type AreaValue,
  type CuttingPlanStockMatch,
  type CuttingRecipeResponse,
  type DonorSuggestion,
  type IssueResult,
  type MaterialSku,
  type MaterialUnit,
} from "../../api/units";
import { suggestLocation } from "../../api/storage";
import { listMaterialSkus } from "../../api/dictionaries";
import { createShopFloorPurchaseRequest, type PurchaseRequestShopFloorCreate } from "../../api/purchasing";
import { listAreas } from "../../api/areas";
import { listSites } from "../../api/sites";
import { listWarehouses } from "../../api/storage";
import {
  listProductionTasks,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineAssignment,
  type ProductionTaskLineIssuedUnit,
} from "../../api/production";
import ResponsiveTable from "../../components/ResponsiveTable";
import CuttingForm, { type CuttingFormInitialWidthCut } from "../../components/CuttingForm";
import ManualCuttingPlanModal from "../../components/ManualCuttingPlanModal";
import { useAuth } from "../../auth/AuthContext";

function issueErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

// Раздел про единую форму резки — донор для CuttingForm нужен как
// MaterialUnit целиком (адрес ячейки/статус/номенклатура), а результат
// поиска донора (DonorSuggestion/план резки) несёт только часть этих
// полей — остальное довоссоздаём из уже известного контекста (sku уже
// выбранной номенклатуры, статус донора всегда "На хранении" — иначе он
// не попал бы в подсказку донора вообще).
function makeDonorUnit(unitId: number, widthMm: number, lengthM: number, warehouseName: string | null, sku: MaterialSku): MaterialUnit {
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
interface CuttingBatchEntry {
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
interface StockDecision {
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
type RowStatus =
  | { kind: "issued"; note: string }
  | { kind: "stock"; match: CuttingPlanStockMatch }
  | { kind: "cut_planned" }
  | { kind: "no_donor" }
  | { kind: "decided" };

function findSku(skus: MaterialSku[] | undefined, material: string, color: string, thickness: number) {
  return skus?.find(
    (s) =>
      s.material.name.toLowerCase() === material.toLowerCase() &&
      s.color.name.toLowerCase() === color.toLowerCase() &&
      Math.abs(s.thickness.value_mm - thickness) < 0.01,
  );
}

interface IssuePrefill {
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
}

interface QueueSelection {
  task: ProductionTask;
  line: ProductionTaskLine;
  assignment?: ProductionTaskLineAssignment;
}

type QueueRowData = { task: ProductionTask; line: ProductionTaskLine; assignment?: ProductionTaskLineAssignment; overdue?: boolean };

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
function neededLengthM(row: QueueRowData): number {
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
function groupQueueRows(rows: QueueRowData[]) {
  const order: string[] = [];
  const groups = new Map<string, { key: string; material: string; color: string; thickness: number; rows: QueueRowData[] }>();
  for (const r of rows) {
    const key = `${r.task.area}|${r.line.material}|${r.line.color}|${r.line.thickness}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, material: r.line.material, color: r.line.color, thickness: r.line.thickness, rows: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.rows.push(r);
  }
  return order.map((k) => groups.get(k)!);
}

/** Альтернативная группировка очереди — по детали, а не по плёнке
 * (раздел про удобство просмотра: мастеру иногда проще искать
 * "все двери с этой филёнкой", а не "все задания под эту плёнку").
 * Внутри каждой группы деталей строки всё равно повторно группируются
 * groupQueueRows (по плёнке) — деталь может понадобиться в разных
 * плёнках на разных заданиях, а план резки/CuttingPlanGroupButton
 * рассчитан ровно на одну плёнку за раз, эту гарантию нельзя терять. */
function groupQueueRowsByPart(rows: QueueRowData[]) {
  const order: string[] = [];
  const groups = new Map<string, { key: string; partName: string; rows: QueueRowData[] }>();
  for (const r of rows) {
    const key = r.line.part_name ?? "Без названия детали";
    let g = groups.get(key);
    if (!g) {
      g = { key, partName: key, rows: [] };
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
/** Подсказка донора на группу строк одной плёнки (раздел про разбор
 * задания единой таблицей) — getCuttingPlan теперь сразу отсекает
 * потребности, уже закрытые точным совпадением на складе (stock_matches,
 * backend/app/api/units.py::get_cutting_plan), поэтому в подбор донора
 * попадают только настоящие нехватки. Решение (и "на складе", и "резать")
 * больше не выполняется сразу по клику — только копится (onAddStockDecision/
 * onAddToBatch), реальное выполнение теперь всегда через "Выполнить всё" в
 * Issue(). renderRow — чтобы каждая строка очереди получила свой статус,
 * посчитанный из ЭТОГО ЖЕ запроса (без него useQuery пришлось бы дублировать
 * на каждую строку по отдельности). */
function CuttingPlanGroupButton({
  sku,
  rows,
  onAddToBatch,
  batchedDonorIds,
  onAddStockDecision,
  decidedLineIds,
  renderRow,
}: {
  sku: MaterialSku | undefined;
  rows: QueueRowData[];
  onAddToBatch: (entry: CuttingBatchEntry) => void;
  batchedDonorIds: Set<number>;
  onAddStockDecision: (decision: StockDecision) => void;
  decidedLineIds: Set<number>;
  renderRow: (row: QueueRowData, status: RowStatus) => ReactNode;
}) {
  const widths = rows.map((r) => r.line.strip_width_mm || r.line.width_mm);
  const lengths = rows.map((r) => neededLengthM(r));
  const planQuery = useQuery({
    queryKey: [
      "cutting-plan",
      sku?.material.name,
      sku?.color.name,
      sku?.thickness.value_mm,
      sku?.manufacturer.name,
      widths.join(","),
      lengths.join(","),
    ],
    queryFn: () =>
      getCuttingPlan({
        material: sku!.material.name,
        color: sku!.color.name,
        thickness: sku!.thickness.value_mm,
        manufacturer: sku!.manufacturer.name,
        needed_widths_mm: widths,
        needed_lengths_m: lengths,
      }),
    enabled: !!sku,
  });

  const [manualOpen, setManualOpen] = useState(false);
  const manualLink = <a onClick={() => setManualOpen(true)}>🔧 Свой донор и раскрой</a>;
  const manualModal = sku && (
    <ManualCuttingPlanModal open={manualOpen} onClose={() => setManualOpen(false)} sku={sku} rows={rows} onAddToBatch={onAddToBatch} />
  );

  const rowStatus = (i: number): RowStatus => {
    const lineId = rows[i].line.id;
    if (decidedLineIds.has(lineId)) return { kind: "decided" };
    const data = planQuery.data;
    if (!data) return { kind: "no_donor" };
    const stockMatch = data.stock_matches.find((m) => m.index === i);
    if (stockMatch) return { kind: "stock", match: stockMatch };
    if (data.donor && data.covered_indices.includes(i)) return { kind: "cut_planned" };
    return { kind: "no_donor" };
  };
  const rowsRendered = rows.map((r, i) => renderRow(r, rowStatus(i)));

  if (!sku || !planQuery.data) return <>{rowsRendered}</>;
  const { donor, covered_widths_mm, uncovered_widths_mm, waste_mm, covered_indices, stock_matches } = planQuery.data;

  const stockRows = stock_matches
    .filter((m) => !decidedLineIds.has(rows[m.index].line.id))
    .map((m) => {
      const row = rows[m.index];
      return (
        <div key={m.index} style={{ fontSize: 12, marginBottom: 4 }}>
          ✅ {row.line.part_name ?? "Деталь"} — есть на складе: штрипс №{m.unit_id} ({m.width_mm} мм, {m.length_m} м
          {m.location_code ? `, ячейка ${m.location_code}` : ""}) ·{" "}
          <a
            onClick={() =>
              onAddStockDecision({
                lineId: row.line.id,
                unitId: m.unit_id,
                area: row.task.area,
                label: row.line.part_name ?? "Деталь",
                widthMm: m.width_mm,
              })
            }
          >
            Использовать
          </a>
        </div>
      );
    });

  if (!donor) {
    return (
      <>
        {stockRows}
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
          {uncovered_widths_mm.length > 0 && "✂️ Подходящего донора для резки на оставшиеся ширины среди остатков нет — резать новый рулон."}
          {" · "}
          {manualLink}
          {manualModal}
        </Typography.Text>
        {rowsRendered}
      </>
    );
  }

  const coveredRows = covered_indices.map((i) => rows[i]);
  const alreadyBatched = batchedDonorIds.has(donor.unit_id);

  const addPlanToBatch = async () => {
    const remainderLocationCode = (await suggestLocation({ material_sku_id: sku.id, is_strip: true })) ?? undefined;
    onAddToBatch({
      donorUnitId: donor.unit_id,
      donorWidthMm: donor.width_mm,
      donorLengthM: donor.length_m,
      wasteMm: waste_mm,
      remainderLocationCode,
      pieces: coveredRows.map((r) => ({
        widthMm: r.line.strip_width_mm || r.line.width_mm,
        label: r.line.part_name ?? "Деталь",
        area: r.task.area,
        productionTaskLineId: r.line.id,
      })),
    });
  };

  return (
    <>
      {stockRows}
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        ✂️ План резки: донор №{donor.unit_id} ({donor.width_mm} мм, {donor.length_m} м) → режем{" "}
        {covered_widths_mm.join(" + ")} мм, отход {waste_mm} мм
        {uncovered_widths_mm.length > 0 && <> · ещё нет донора на {uncovered_widths_mm.join(", ")} мм</>}
        {" · "}
        {alreadyBatched ? (
          <Typography.Text type="success">✓ В списке на резку</Typography.Text>
        ) : (
          <a onClick={addPlanToBatch}>+ В список на резку</a>
        )}
        {" · "}
        {manualLink}
        {manualModal}
      </Typography.Text>
      {rowsRendered}
    </>
  );
}

interface IssuedResult {
  unit: MaterialUnit;
  remainder: MaterialUnit | null;
  remainderPlaced: boolean;
}

export default function Issue() {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canReturn = !!user?.is_superuser || !!user?.permissions.includes("units.return");
  // Раздел про замену плёнки на выдаче — той же номенклатуры может не быть
  // в наличии, точный аналог по цвету/толщине оператор решает подобрать
  // сам вместо заявки на закупку; сервер запомнит расхождение в строке
  // задания только при наличии этого права (units.py::_validate_matches_
  // task_line), иначе как раньше — жёсткий отказ.
  const canOverrideMaterial = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const prefill = (location.state as IssuePrefill | null) ?? undefined;

  const [selected, setSelected] = useState<QueueSelection | null>(null);
  // Раздел про замену плёнки на выдаче — SKU, выбранный оператором вместо
  // того, что требует строка задания.
  const [substituteSkuId, setSubstituteSkuId] = useState<number | undefined>(undefined);
  const [areaFilter, setAreaFilter] = useState<AreaValue | undefined>(undefined);
  // Раздел про фильтр по заданию — очередь по умолчанию показывает сразу
  // все активные задания вперемешку (только по участку/тексту можно было
  // сузить); выбор конкретного задания даёт тот же список, только на одно
  // задание, вместо поиска его строк среди остальных вручную.
  const [taskFilter, setTaskFilter] = useState<number | undefined>(undefined);
  // Раздел про группировку очереди по детали — переключатель "по плёнке"
  // (как раньше, groupQueueRows) / "по детали" (groupQueueRowsByPart).
  const [groupBy, setGroupBy] = useState<"film" | "part">("film");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<IssueResult | null>(null);
  const [lastIssued, setLastIssued] = useState<IssuedResult | null>(null);
  // Раздел про единую форму резки — один общий модальный CuttingForm для
  // всех сценариев резки+выдачи на этом экране (точечный донор у строки
  // задания, план резки на несколько строк сразу, ручной подбор без
  // задания), вместо трёх разных модалок/мутаций раньше. onDone у каждого
  // вызова свой — одиночная резка заводит карточку "Выдано" (lastIssued),
  // групповой план резки просто закрывается и инвалидирует кэш заданий.
  const [cuttingSession, setCuttingSession] = useState<{
    donor: MaterialUnit;
    widthCuts: CuttingFormInitialWidthCut[];
    onDone: (res: CuttingRecipeResponse) => void;
  } | null>(null);

  // Раздел про разбор задания единой таблицей — план ЕЩЁ НЕ выполненный
  // физически, поэтому сам по себе не бьёт в бэкенд — просто накапливает
  // уже посчитанные планы резки (CuttingPlanGroupButton/ManualCuttingPlanModal
  // — тот же /units/cutting-plan запрос, что и раньше). Только групповые
  // планы — одиночные резки по одной строке (без группы) сюда не попадают,
  // остаются как были (свой cuttingSession/CuttingForm). В отличие от
  // прошлой версии, этот батч — не только печать: "Выполнить всё"
  // (executeAllDecisions ниже) реально режет каждую запись.
  const [cuttingBatch, setCuttingBatch] = useState<CuttingBatchEntry[]>([]);
  const [cuttingBatchOpen, setCuttingBatchOpen] = useState(false);
  // Раздел про разбор задания единой таблицей — сопроводительный лист,
  // отдельный от «Списка на резку», по одному заданию за раз.
  const [slipModalOpen, setSlipModalOpen] = useState(false);
  const [slipTaskId, setSlipTaskId] = useState<number | undefined>(undefined);
  const addToCuttingBatch = (entry: CuttingBatchEntry) =>
    setCuttingBatch((prev) => (prev.some((e) => e.donorUnitId === entry.donorUnitId) ? prev : [...prev, entry]));
  const removeFromCuttingBatch = (donorUnitId: number) =>
    setCuttingBatch((prev) => prev.filter((e) => e.donorUnitId !== donorUnitId));
  const cuttingBatchDonorIds = useMemo(() => new Set(cuttingBatch.map((e) => e.donorUnitId)), [cuttingBatch]);

  // Раздел про разбор задания единой таблицей — решения "выдать со
  // склада" (stock_matches из /units/cutting-plan), тот же принцип
  // отложенного выполнения, что и у cuttingBatch выше, только для готовых
  // штрипсов, не требующих резки вообще.
  const [stockDecisions, setStockDecisions] = useState<StockDecision[]>([]);
  const addStockDecision = (d: StockDecision) =>
    setStockDecisions((prev) => (prev.some((e) => e.lineId === d.lineId) ? prev : [...prev, d]));
  const removeStockDecision = (lineId: number) => setStockDecisions((prev) => prev.filter((e) => e.lineId !== lineId));
  const decidedLineIds = useMemo(() => {
    const ids = new Set(stockDecisions.map((d) => d.lineId));
    for (const entry of cuttingBatch) for (const p of entry.pieces) if (p.productionTaskLineId != null) ids.add(p.productionTaskLineId);
    return ids;
  }, [stockDecisions, cuttingBatch]);
  const [executingAll, setExecutingAll] = useState(false);

  // Раздел про разбор задания единой таблицей — решение принимается в
  // таблице заранее (склад/резка), выполнение — здесь и только по этой
  // кнопке, по очереди (не Promise.all — чтобы точно знать, какое именно
  // решение упало и почему, а не только "что-то из N не получилось").
  // Успешные решения убираются из стейта сразу; проваленные остаются —
  // можно поправить и попробовать снова.
  const executeAllDecisions = async () => {
    if (executingAll) return;
    setExecutingAll(true);
    const failed: { label: string; error: string }[] = [];
    let okCount = 0;
    for (const d of stockDecisions) {
      try {
        await issueUnitDirect(d.unitId, d.area, d.lineId, toOccurredAtIso(occurredAt));
        removeStockDecision(d.lineId);
        okCount++;
      } catch (e) {
        failed.push({ label: `${d.label} — штрипс №${d.unitId}`, error: issueErrorMessage(e, "не удалось выдать") });
      }
    }
    for (const entry of cuttingBatch) {
      try {
        await executeCuttingRecipe({
          donor_unit_id: entry.donorUnitId,
          width_cuts: entry.pieces.map((p) => ({
            width_mm: p.widthMm,
            destination: { kind: "issue", area: p.area, production_task_line_id: p.productionTaskLineId },
            actual_length_m: entry.donorLengthM,
          })),
          occurred_at: toOccurredAtIso(occurredAt),
        });
        removeFromCuttingBatch(entry.donorUnitId);
        okCount++;
      } catch (e) {
        failed.push({ label: `Донор №${entry.donorUnitId} (${entry.pieces.length} кус.)`, error: issueErrorMessage(e, "не удалось разрезать") });
      }
    }
    setExecutingAll(false);
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
    qc.invalidateQueries({ queryKey: ["issue-available-units"] });
    qc.invalidateQueries({ queryKey: ["cutting-plan"] });
    if (failed.length === 0) {
      message.success(`Выполнено решений: ${okCount}`);
    } else {
      Modal.warning({
        title: `Выполнено ${okCount} из ${okCount + failed.length} — есть ошибки`,
        content: (
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {failed.map((f, i) => (
              <li key={i}>
                {f.label}: {f.error}
              </li>
            ))}
          </ul>
        ),
      });
    }
  };

  // Раздел про скролл на планшете — правая панель раньше молча "отдавала"
  // прокрутку в левую очередь, дойдя до низа, без намёка на то, что там
  // ещё есть контент. ResizeObserver на самой панели (не только onScroll)
  // — чтобы подсказка пересчитывалась и когда высота содержимого меняется
  // сама по себе (выбор задания, карточка "Выдано", разворот Collapse),
  // без перечисления каждой такой зависимости вручную.
  const [stickyPanelEl, setStickyPanelEl] = useState<HTMLDivElement | null>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const stickyPanelRef = useCallback((node: HTMLDivElement | null) => setStickyPanelEl(node), []);
  const recomputeHasMoreBelow = useCallback(() => {
    if (!stickyPanelEl) return;
    setHasMoreBelow(stickyPanelEl.scrollHeight - stickyPanelEl.scrollTop - stickyPanelEl.clientHeight > 4);
  }, [stickyPanelEl]);
  useEffect(() => {
    if (!stickyPanelEl) return;
    recomputeHasMoreBelow();
    const observer = new ResizeObserver(recomputeHasMoreBelow);
    observer.observe(stickyPanelEl);
    return () => observer.disconnect();
  }, [stickyPanelEl, recomputeHasMoreBelow]);

  const [manualSkuId, setManualSkuId] = useState<number | null>(null);
  const [manualArea, setManualArea] = useState<AreaValue | null>(null);
  const [manualForm] = Form.useForm<{ width_mm: number; length_m: number }>();
  // Раздел про нарезку в ширину без привязки к заданию — донор,
  // предложенный на "Найти и выдать" ниже, когда точного совпадения по
  // ширине нет (тот же outcome="donor_suggested", что и в задачной
  // очереди выше, просто своё состояние — эта карточка донора относится к
  // ручному подбору, не к выбранной строке задания).
  const [manualDonor, setManualDonor] = useState<DonorSuggestion | null>(null);
  // Раздел про выдачу мимо хаба — на своём складе ничего не нашлось, но
  // на другом складе материал есть (backend/api/units.py::issue_to_area
  // отдаёт elsewhere_warehouse_name) — подсказать подготовить и отправить
  // через хаб, а не сразу вести к заявке на закупку.
  const [manualElsewhere, setManualElsewhere] = useState<string | null>(null);
  const [shortageModalOpen, setShortageModalOpen] = useState(false);
  const [shortageForm] = Form.useForm<PurchaseRequestShopFloorCreate>();
  // Раздел про дату операции задним числом — одно поле на весь экран
  // выдачи (не дублируется в каждой из веток ниже): выдача обычно
  // фиксируется по факту через день-два после самого события.
  const [occurredAt, setOccurredAt] = useState<Dayjs | null>(null);

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  // Раздел про нулевые позиции при выдаче — отдельный запрос только для
  // списка в ручном подборе (skusQuery выше нужен целиком, включая
  // позиции без остатка: findSku по строке задания должен находить их
  // тоже, иначе очередь по заданию не сможет предложить донора/заявку на
  // нехватку для материала, которого сейчас физически нет вообще).
  const manualSkusQuery = useQuery({ queryKey: ["material-skus", "in-stock"], queryFn: () => listMaterialSkus(true) });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  // Раздел про отключение распределения по дням — для такого участка
  // строка в очереди "week" не помечается как "не распределено" (это её
  // нормальное постоянное состояние, а не сигнал забытой распределения).
  const areaRequiresDailyPlan = (code: string) => areasQuery.data?.find((a) => a.code === code)?.requires_daily_plan ?? true;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const taskOptions = (tasksQuery.data ?? [])
    .filter((t) => t.is_active)
    .map((t) => ({ value: t.id, label: t.product_model_name ?? t.name ?? `Задание №${t.id}` }));

  // Раздел про площадки — домашний склад участка (Северный/Фабрика), чтобы
  // подбор донора в первую очередь искал "на своём" складе и предупреждал,
  // если оператор всё же берёт единицу с другого. Участок без площадки —
  // домашнего склада нет, ищем/выдаём как раньше, без ограничения.
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: listSites });
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });
  const homeWarehouseFor = (areaCode: string | null | undefined): { id: number; name: string } | null => {
    const area = areasQuery.data?.find((a) => a.code === areaCode);
    if (!area?.site_id) return null;
    const site = sitesQuery.data?.find((s) => s.id === area.site_id);
    if (!site) return null;
    const warehouse = warehousesQuery.data?.find((w) => w.id === site.warehouse_id);
    return warehouse ? { id: warehouse.id, name: warehouse.name } : null;
  };

  // Раздел про выдачу мимо хаба — раньше здесь было "предупредить, но
  // разрешить" (Modal.confirm с кнопкой-обходом). Теперь это настоящий
  // жёсткий блок на бэкенде (assert_area_home_warehouse) — фронт только
  // объясняет причину заранее и не даёт кнопки "всё равно выдать", чтобы
  // не вести оператора к заведомо провальному запросу. Поиск в очереди
  // тоже теперь ограничен своим складом (backend/api/units.py::issue_to_area),
  // так что это предупреждение — подстраховка на редких путях (прямая
  // выдача конкретной единицы из карточки/списка), где единица уже
  // выбрана руками, а не найдена поиском.
  const confirmIfWrongWarehouse = (
    unitWarehouseName: string | null | undefined,
    areaCode: string | null | undefined,
    onConfirmed: () => void,
  ) => {
    const home = homeWarehouseFor(areaCode);
    if (!home || !unitWarehouseName || unitWarehouseName === home.name) {
      onConfirmed();
      return;
    }
    Modal.error({
      title: "Плёнка с другого склада — выдать нельзя",
      content: `Единица физически лежит на складе «${unitWarehouseName}», а для этого участка домашний склад — «${home.name}». Сначала переместите её через «Перемещения между складами», затем выдайте уже с домашнего склада.`,
      okText: "Понятно",
    });
  };

  // Раздел про видимость выданного вручную — "Выдано по заданиям" ниже
  // строится строго из строк заданий и никогда не покажет единицу,
  // выданную в обход задания (issueUnitDirect/manualDirectMutation и
  // т.п.). Отдельный запрос по статусу "Выдан участку" находит и такие
  // тоже — фильтруем на клиенте по отсутствию production_task_line_id
  // (обратное тому, что делает issuedLines).
  const manualIssuedQuery = useQuery({
    queryKey: ["issue-manual-issued", areaFilter],
    queryFn: () => searchUnits({ status: "Выдан_участку", area: areaFilter ?? undefined }),
  });
  const manualIssuedUnits = (manualIssuedQuery.data ?? []).filter((u) => !u.production_task_line_id);

  // --- Очередь: "запрошено сегодня/просрочено" (из распределения по дням)
  // и "задания недели" (остаток по строкам, для которых на сегодня ничего
  // не распределено) — раздел про экран выдачи: складу нужны
  // производственные задания, а не заказы покупателей.
  const today = dayjs().format("YYYY-MM-DD");

  // Строка попадает в очередь не по голому остатку штук, а по нехватке
  // уже выданной плёнки (shortfall_length_m, backend) — раздел про
  // «потребности» после выдачи: как только выдано достаточно на весь
  // план, строка уходит из очереди в «Выдано по заданиям», даже если
  // производство ещё не отчиталось о готовых деталях. Довыдача
  // открывается заново только отчётом о браке (см.
  // compute_shortfall_length_m) — сам факт остатка штук её не включает.
  // task.is_active — заархивированное задание (раздел про удаление
  // сущностей — задание с реальной историей выдачи нельзя удалить,
  // только заархивировать) не должно ни просить довыдать плёнку, ни
  // висеть в ленте расхода: экран "Выдача" раньше вообще не смотрел на
  // is_active, и заархивированное тестовое задание с ещё не выданными
  // строками продолжало значиться в очереди как реальная потребность.
  // Раздел про разбор задания единой таблицей — раньше строка с
  // remaining_pieces > 0, но уже выданной вплоть до shortfall_length_m
  // <= 0, полностью пропадала из очереди (видна была только позже, в
  // "Выдано по заданиям" далеко внизу экрана). Условие по
  // shortfall_length_m снято — такая строка остаётся в очереди со
  // статусом "выдано" (issuedNoteForLine в queueRow), не требуя листать
  // экран, чтобы понять, что по ней уже сделано.
  const activeLines = useMemo(
    () =>
      (tasksQuery.data ?? [])
        .filter((task) => task.is_active)
        .flatMap((task) => task.lines.filter((line) => line.remaining_pieces > 0).map((line) => ({ task, line }))),
    [tasksQuery.data],
  );

  const assignmentRows = useMemo(() => {
    const rows = activeLines.flatMap(({ task, line }) =>
      (line.assignments ?? [])
        .filter((a) => a.date <= today)
        .map((assignment) => ({ task, line, assignment, overdue: assignment.date < today })),
    );
    rows.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return a.assignment.date.localeCompare(b.assignment.date);
    });
    return rows;
  }, [activeLines, today]);

  const linesWithTodayAssignment = useMemo(() => new Set(assignmentRows.map((r) => r.line.id)), [assignmentRows]);
  const weekRows = useMemo(
    () => activeLines.filter(({ line }) => !linesWithTodayAssignment.has(line.id)),
    [activeLines, linesWithTodayAssignment],
  );

  // "Выдано по заданиям" — по всем строкам, не только активным
  // (remaining_pieces > 0): завершённая строка с уже выданной плёнкой
  // остаётся в ленте расхода, это не список "что ещё нужно выдать". Но
  // заархивированное задание (task.is_active) — уже нет, ленту расхода
  // рабочего экрана "Выдача" оно засорять не должно (сама история
  // событий никуда не девается, просто здесь не показывается).
  const issuedLines = useMemo(
    () =>
      (tasksQuery.data ?? [])
        .filter((task) => task.is_active)
        .flatMap((task) => task.lines.filter((line) => line.issued_length_m > 0).map((line) => ({ task, line }))),
    [tasksQuery.data],
  );

  const matchesFilter = (task: ProductionTask, line: ProductionTaskLine) => {
    if (areaFilter && task.area !== areaFilter) return false;
    if (taskFilter && task.id !== taskFilter) return false;
    if (search.trim()) {
      const haystack = `${line.part_name ?? ""} ${task.product_model_name ?? task.name ?? ""} ${line.material} ${line.color}`.toLowerCase();
      if (!haystack.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  };

  const filteredAssignmentRows = assignmentRows.filter((r) => matchesFilter(r.task, r.line));
  const filteredWeekRows = weekRows.filter((r) => matchesFilter(r.task, r.line));

  const overdueCount = assignmentRows.filter((r) => r.overdue).length;
  const todayCount = assignmentRows.length - overdueCount;
  // Раздел про разбор задания единой таблицей — weekRows теперь включает
  // и уже полностью выданные строки (видны в очереди статусом "выдано"
  // вместо исчезновения), но счётчики ниже по-прежнему должны отражать
  // реальную НЕХВАТКУ, не общее число строк в очереди.
  const weekRowsNeedingMaterial = weekRows.filter((r) => r.line.shortfall_length_m > 0);
  const areasWaiting = new Set(
    [...assignmentRows, ...weekRowsNeedingMaterial].filter((r) => r.line.shortfall_length_m > 0).map((r) => r.task.area),
  ).size;

  // --- Выбранная потребность: авто-подбор точного/донор-штрипса сразу
  // после выбора строки в очереди, без лишнего клика "искать".
  const selectedSku = selected ? findSku(skusQuery.data, selected.line.material, selected.line.color, selected.line.thickness) : undefined;
  const selectedStripWidth = selected ? selected.line.strip_width_mm || selected.line.width_mm : 0;
  // Раздел про общий погонаж на партию деталей — раньше искали и выдавали
  // строго на ОДНУ деталь (line.length_m), даже когда по строке нужно
  // сразу несколько: 4 детали одной ширины оборачивались 4 отдельными
  // подборами донора (иногда — 4 разными физическими штрипсами), хотя
  // одного достаточной длины хватило бы на все 4 (порезать по длине уже
  // на участке). См. neededLengthM выше.
  const selectedNeededLengthM = selected ? neededLengthM(selected) : 0;

  // findMutation (issueUnit/POST /units/issue) сам выдаёт единицу и коммитит
  // это в БД, когда находит точное совпадение по ширине — раньше вызывался
  // сразу по выбору строки в очереди, без подтверждения (клик по карточке
  // = реальное списание склада, баг: строку выбирали просто посмотреть, а
  // плёнка уже уходила). Теперь при точном совпадении вызывать его вообще
  // не нужно — оно видно и так из уже загруженного availableQuery
  // (exactMatch ниже), показывается предпросмотром, а выдаёт по клику
  // "Выдать" уже issueUnitDirect/directMutation (та же функция, что и в
  // "Показать остатки" ниже) — сам find-эндпоинт вызывается только когда
  // точного совпадения точно нет, тогда он ничего сам не выдаст, только
  // предложит донора (или скажет, что и донора нет).
  const findMutation = useMutation({
    mutationFn: () =>
      issueUnit({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        width_mm: selectedStripWidth,
        length_m: selectedNeededLengthM,
        area: selected!.task.area,
        production_task_line_id: selected!.line.id,
        occurred_at: toOccurredAtIso(occurredAt),
      }),
    onSuccess: (res) => setResult(res),
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось подобрать штрипс")),
  });

  useEffect(() => {
    if (!selected || !selectedSku) return;
    setResult(null);
    setLastIssued(null);
    setSubstituteSkuId(undefined);
  }, [selected?.line.id, selectedSku?.id]);

  // Раздел про замену плёнки на выдаче — сток по SKU, выбранному оператором
  // вместо номенклатуры строки задания (та же форма запроса, что и
  // availableQuery ниже, только по другому SKU).
  const substituteSku = skusQuery.data?.find((s) => s.id === substituteSkuId) ?? null;
  const substituteAvailableQuery = useQuery({
    queryKey: ["issue-substitute-available", substituteSkuId],
    queryFn: () =>
      searchUnits({
        material: substituteSku!.material.name,
        color: substituteSku!.color.name,
        thickness: substituteSku!.thickness.value_mm,
        manufacturer: substituteSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!substituteSku,
  });

  const availableQuery = useQuery({
    queryKey: ["issue-available-units", selectedSku?.id],
    queryFn: () =>
      searchUnits({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!selectedSku,
  });

  // Точное совпадение по ширине — предпросмотр из уже загруженного
  // availableQuery (без похода на бэкенд), с сортировкой по длине, чтобы
  // предлагать в первую очередь короткий, но достаточный кусок (не
  // залёживать длинные, тот же принцип, что и у backend-подбора). Явное
  // подтверждение — кнопка "Выдать" ниже (directMutation), не сам факт
  // выбора строки.
  const exactMatch = useMemo(() => {
    if (!selected) return null;
    const candidates = (availableQuery.data ?? []).filter(
      (u) => u.width_mm === selectedStripWidth && u.length_m >= selectedNeededLengthM,
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => a.length_m - b.length_m)[0];
  }, [selected, availableQuery.data, selectedStripWidth, selectedNeededLengthM]);

  // findMutation вызывается только когда точного совпадения точно нет
  // (availableQuery уже загрузился и exactMatch пуст) — тогда find-эндпоинт
  // сам ничего не выдаст, только предложит донора или скажет, что и его нет.
  useEffect(() => {
    if (!selected || !selectedSku) return;
    if (availableQuery.isLoading || exactMatch) return;
    findMutation.mutate();
    // findMutation.mutate имеет стабильную идентичность между рендерами (react-query) — не в зависимостях намеренно
  }, [selected?.line.id, selectedSku?.id, availableQuery.isLoading, exactMatch]);

  // --- Нехватка остатка под выбранную строку задания (раздел про замену
  // "Заказов покупателей" — нехватка обнаруживается в моменте выдачи, не
  // на отдельном экране планирования). needed — на весь довыдаваемый
  // остаток строки задания (shortfall_length_m — раздел про очередь
  // «потребности» после выдачи), не голый остаток по штукам: то, что уже
  // выдано, не должно завышать площадь для заявки на закупку.
  const neededM2 = selected ? (selectedStripWidth / 1000) * selected.line.shortfall_length_m : 0;
  const availableM2 = (availableQuery.data ?? []).reduce((sum, u) => sum + u.area_m2, 0);
  const shortfallM2 = Math.max(0, Math.round((neededM2 - availableM2) * 100) / 100);

  const shopFloorRequestMutation = useMutation({
    mutationFn: (payload: PurchaseRequestShopFloorCreate) => createShopFloorPurchaseRequest(payload),
    onSuccess: () => {
      message.success("Заявка на закупку отправлена");
      setShortageModalOpen(false);
    },
    onError: () => message.error("Не удалось создать заявку"),
  });

  const openShortageModal = () => {
    if (!selectedSku || !selected) return;
    shortageForm.setFieldsValue({
      material: selectedSku.material.name,
      color: selectedSku.color.name,
      thickness: selectedSku.thickness.value_mm,
      requested_area_m2: shortfallM2,
      note: `${selected.line.part_name ?? "Деталь"} — ${selected.task.product_model_name ?? selected.task.name ?? `Задание №${selected.task.id}`}`,
    });
    setShortageModalOpen(true);
  };

  const directMutation = useMutation({
    mutationFn: ({ unitId, override = false }: { unitId: number; override?: boolean }) =>
      issueUnitDirect(unitId, selected!.task.area, selected!.line.id, toOccurredAtIso(occurredAt), override, override),
    onSuccess: (unit) => {
      // Раздел про выдачу мимо хаба — участок физически на другом складе
      // (units.py::auto_transfer_if_wrong_warehouse): сервер сам отправил
      // единицу в хаб на перемещение вместо выдачи, "Выдано" здесь было бы
      // неправдой — единица ещё не у участка, только в пути.
      if (unit.status === "В_перемещении") {
        message.success("Материал физически на другом складе — автоматически отправлен в хаб на перемещение");
        qc.invalidateQueries({ queryKey: ["issue-available-units"] });
        qc.invalidateQueries({ queryKey: ["issue-substitute-available"] });
        return;
      }
      setLastIssued({ unit, remainder: null, remainderPlaced: false });
      setResult(null);
      qc.invalidateQueries({ queryKey: ["issue-available-units"] });
      qc.invalidateQueries({ queryKey: ["issue-substitute-available"] });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось выдать")),
  });

  // Один и тот же результат одиночной резки+выдачи (result.donor, строка
  // остатков на складе, ручной подбор) заводится в уже существующую
  // карточку "Выдано / остаток" ниже (lastIssued) — та же полировка
  // (печать бирки, подсказка адреса для остатка), что была у прежнего
  // atomicDonorMutation, теперь общая для всех трёх мест.
  const finishSingleCut = (res: CuttingRecipeResponse) => {
    const piece = res.width_results[0] ?? res.length_result;
    if (!piece) return;
    setLastIssued({
      unit: piece.unit,
      remainder: res.donor_remainder.status === "На_хранении" ? res.donor_remainder : null,
      remainderPlaced: false,
    });
    setResult(null);
    qc.invalidateQueries({ queryKey: ["issue-available-units"] });
  };

  const remainderSuggestion = useQuery({
    queryKey: ["suggest-location", "issue-remainder", lastIssued?.remainder?.id],
    queryFn: () =>
      suggestLocation({
        material_sku_id: lastIssued!.remainder!.material_sku.id,
        is_strip: lastIssued!.remainder!.is_strip,
      }),
    enabled: !!lastIssued?.remainder && !lastIssued.remainderPlaced,
  });

  const placeRemainderMutation = useMutation({
    mutationFn: (locationCode: string) =>
      placeUnit(lastIssued!.remainder!.id, locationCode, toOccurredAtIso(occurredAt)),
    onSuccess: () => {
      setLastIssued((prev) => (prev ? { ...prev, remainderPlaced: true } : prev));
      message.success("Остаток размещён");
    },
    onError: () => message.error("Не удалось разместить остаток"),
  });

  const finishAndReset = () => {
    setSelected(null);
    setResult(null);
    setLastIssued(null);
  };

  // --- Ручной подбор без привязки к заданию (редкий случай — плёнка не
  // относится ни к одному заданию). Строгая проверка соответствия здесь
  // не применяется, т.к. нет строки задания, с которой сверять.
  const manualSku = skusQuery.data?.find((s) => s.id === manualSkuId) ?? null;

  useEffect(() => {
    if (!prefill || !skusQuery.data) return;
    if (prefill.material && prefill.color && prefill.thickness) {
      const match = findSku(skusQuery.data, prefill.material, prefill.color, prefill.thickness);
      if (match) setManualSkuId(match.id);
    }
  }, [prefill, skusQuery.data]);

  const manualAvailableQuery = useQuery({
    queryKey: ["issue-manual-available", manualSkuId],
    queryFn: () =>
      searchUnits({
        material: manualSku!.material.name,
        color: manualSku!.color.name,
        thickness: manualSku!.thickness.value_mm,
        manufacturer: manualSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!manualSku,
  });

  const manualDirectMutation = useMutation({
    mutationFn: (unitId: number) => issueUnitDirect(unitId, manualArea!, undefined, toOccurredAtIso(occurredAt)),
    onSuccess: (unit) => {
      setLastIssued({ unit, remainder: null, remainderPlaced: false });
      setManualDonor(null);
      qc.invalidateQueries({ queryKey: ["issue-manual-available"] });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось выдать")),
  });

  const manualFindMutation = useMutation({
    mutationFn: (v: { width_mm: number; length_m: number }) =>
      issueUnit({
        material: manualSku!.material.name,
        color: manualSku!.color.name,
        thickness: manualSku!.thickness.value_mm,
        manufacturer: manualSku!.manufacturer.name,
        width_mm: v.width_mm,
        length_m: v.length_m,
        area: manualArea!,
        occurred_at: toOccurredAtIso(occurredAt),
      }),
    onSuccess: (res) => {
      if (res.outcome === "issued" && res.unit) {
        setLastIssued({ unit: res.unit, remainder: null, remainderPlaced: false });
        setManualDonor(null);
        setManualElsewhere(null);
        qc.invalidateQueries({ queryKey: ["issue-manual-available"] });
      } else if (res.outcome === "not_found") {
        setManualDonor(null);
        setManualElsewhere(res.elsewhere_warehouse_name ?? null);
        if (!res.elsewhere_warehouse_name) {
          message.warning("Точного совпадения по ширине нет — донора тоже нет, режьте новый рулон");
        }
      } else if (res.outcome === "donor_suggested" && res.donor) {
        setManualDonor(res.donor);
        setManualElsewhere(null);
      }
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось оформить выдачу")),
  });

  // Раздел про разбор задания единой таблицей — строка "выдано" не должна
  // молча пропадать из очереди, как только shortfall_length_m обнулился
  // (см. allTaskLines ниже, ослабленный фильтр); достаточно ли выдано, и
  // в каком состоянии физически находится кусок — реальный статус
  // единиц (status теперь приходит на ProductionTaskLineIssuedUnit)
  // важнее любого производного статуса плана резки, раз материал уже
  // решён по факту.
  const issuedNoteForLine = (line: ProductionTaskLine): string | null => {
    if (line.shortfall_length_m > 0) return null;
    const units = line.issued_units ?? [];
    if (units.some((u) => u.status === "В_перемещении")) return "🚚 едет через хаб";
    if (units.some((u) => u.status === "На_хранении")) return "🏭 на складе, ждёт довыдачи";
    return "✅ выдано";
  };

  const renderStatusPill = (status: RowStatus | undefined, issuedNote: string | null) => {
    if (issuedNote) return <Tag color="green">{issuedNote}</Tag>;
    if (!status) return null;
    switch (status.kind) {
      case "stock":
        return <Tag color="green">✅ на складе №{status.match.unit_id}</Tag>;
      case "cut_planned":
        return <Tag color="gold">✂️ план резки</Tag>;
      case "no_donor":
        return <Tag color="red">✖ нет донора</Tag>;
      case "decided":
        return <Tag color="processing">🕒 решено</Tag>;
      default:
        return null;
    }
  };

  const queueRow = (
    r: { task: ProductionTask; line: ProductionTaskLine; assignment?: ProductionTaskLineAssignment; overdue?: boolean },
    variant: "today" | "week",
    status?: RowStatus,
  ) => {
    const isSelected = selected?.line.id === r.line.id && selected?.assignment?.id === r.assignment?.id;
    const sw = r.line.strip_width_mm || r.line.width_mm;
    const issuedNote = issuedNoteForLine(r.line);
    return (
      <div
        key={`${r.line.id}-${r.assignment?.id ?? "week"}`}
        onClick={() => setSelected({ task: r.task, line: r.line, assignment: r.assignment })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          marginBottom: 8,
          borderRadius: 10,
          borderTop: `1px solid ${isSelected ? "#C97A2B" : "#DEDEDA"}`,
          borderRight: `1px solid ${isSelected ? "#C97A2B" : "#DEDEDA"}`,
          borderBottom: `1px solid ${isSelected ? "#C97A2B" : "#DEDEDA"}`,
          borderLeft: r.overdue ? "3px solid #B8483C" : `1px solid ${isSelected ? "#C97A2B" : "#DEDEDA"}`,
          boxShadow: isSelected ? "0 0 0 2px #FBF0E3" : undefined,
          cursor: "pointer",
          background: "#fff",
        }}
      >
        {variant === "today" ? (
          <Tag color={r.overdue ? "error" : "orange"} style={{ margin: 0, flexShrink: 0 }}>
            {r.overdue ? `просрочено · ${dayjs(r.assignment!.date).format("DD.MM")}` : "сегодня"}
          </Tag>
        ) : areaRequiresDailyPlan(r.task.area) ? (
          <Tag style={{ margin: 0, flexShrink: 0 }}>не распределено на сегодня</Tag>
        ) : (
          <Tag color="blue" style={{ margin: 0, flexShrink: 0 }}>план по участку</Tag>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{r.line.part_name ?? "Деталь без названия"}</div>
          <div style={{ fontSize: 12.5, color: "#8A8C99" }}>
            {r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}`} · {areaLabel(r.task.area)}
            {r.assignment ? ` · ${r.assignment.line_name} · ${r.assignment.employee_names}` : ""}
          </div>
          <Space size={4} wrap style={{ marginTop: 4 }}>
            <Tag color="blue">штрипс {sw} мм</Tag>
            <Tag>{r.line.material}, {r.line.color}, {r.line.thickness} мм</Tag>
            {renderStatusPill(status, issuedNote)}
          </Space>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontWeight: 700 }}>
            {r.assignment
              ? `${r.assignment.quantity_pieces} шт (${neededLengthM(r).toFixed(2)} м)`
              : `довыдать ${r.line.shortfall_length_m} м`}
          </div>
          <div style={{ fontSize: 11.5, color: "#8A8C99" }}>
            {r.assignment ? `${r.line.length_m} м на штрипс` : `остаток ${r.line.remaining_pieces} шт`}
          </div>
        </div>
      </div>
    );
  };

  // Раздел про разбор задания единой таблицей — второй печатный документ,
  // отдельный от «Списка на резку» (тот едет резчикам, без привязки к
  // заданию/участку): сопроводительный лист едет вместе с плёнкой на
  // конкретный участок под конкретное задание — что именно выдано
  // (деталь/кол-во/материал), явным номером рулона/штрипса на каждую
  // деталь, а не общей фразой. По одному заданию за раз (выбор — Select
  // рядом с кнопкой), не общий список сразу по всем.
  const printFactorySlip = (task: ProductionTask) => {
    const rows: Record<string, unknown>[] = [];
    for (const line of task.lines) {
      const issuedNote = issuedNoteForLine(line);
      if (issuedNote) {
        for (const u of line.issued_units) {
          rows.push({
            part: line.part_name ?? "Деталь",
            qty: `${line.quantity_pieces} шт`,
            material: `${line.material}, ${line.color}, ${line.thickness} мм`,
            unit: u.id,
            status:
              u.status === "В_перемещении"
                ? "🚚 едет через хаб"
                : u.status === "На_хранении"
                  ? "на складе, ждёт довыдачи"
                  : "✅ выдано",
          });
        }
        continue;
      }
      const stockDecision = stockDecisions.find((d) => d.lineId === line.id);
      if (stockDecision) {
        rows.push({
          part: line.part_name ?? "Деталь",
          qty: `${line.quantity_pieces} шт`,
          material: `${line.material}, ${line.color}, ${line.thickness} мм`,
          unit: `${stockDecision.unitId}`,
          status: "решено, ещё не выдано",
        });
        continue;
      }
      const cutPiece = cuttingBatch.flatMap((e) => e.pieces.map((p) => ({ e, p }))).find(({ p }) => p.productionTaskLineId === line.id);
      if (cutPiece) {
        rows.push({
          part: line.part_name ?? "Деталь",
          qty: `${line.quantity_pieces} шт`,
          material: `${line.material}, ${line.color}, ${line.thickness} мм`,
          unit: `${cutPiece.e.donorUnitId} (донор)`,
          status: "запланировано, ещё не разрезан",
        });
      }
    }
    if (rows.length === 0) {
      message.warning("По этому заданию пока нет ни выданного, ни принятых решений");
      return;
    }
    printReport(
      `Сопроводительный лист — ${task.product_model_name ?? task.name ?? `Задание №${task.id}`}`,
      [
        { key: "part", header: "Деталь" },
        { key: "qty", header: "Кол-во" },
        { key: "material", header: "Материал" },
        { key: "unit", header: "№ рулона/штрипса" },
        { key: "status", header: "Статус" },
      ],
      rows,
    );
  };

  const renderFilmGroup = (g: ReturnType<typeof groupQueueRows>[number], variant: "today" | "week") =>
    g.rows.length > 1 ? (
      <div
        key={g.key}
        style={{
          marginBottom: 12,
          padding: "10px 12px 2px",
          borderRadius: 10,
          background: "#FBF6EE",
          border: "1px dashed #D8B98A",
        }}
      >
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#8A6A2F", marginBottom: 4 }}>
          🧩 Одна плёнка на {g.rows.length} задания: {g.material}, {g.color}, {g.thickness} мм — итого{" "}
          {g.rows.reduce((sum, r) => sum + neededLengthM(r), 0).toFixed(2)} м
        </div>
        <CuttingPlanGroupButton
          sku={findSku(skusQuery.data, g.material, g.color, g.thickness)}
          rows={g.rows}
          onAddToBatch={addToCuttingBatch}
          batchedDonorIds={cuttingBatchDonorIds}
          onAddStockDecision={addStockDecision}
          decidedLineIds={decidedLineIds}
          renderRow={(r, status) => queueRow(r, variant, status)}
        />
      </div>
    ) : (
      queueRow(g.rows[0], variant)
    );

  const renderByFilm = (rows: QueueRowData[], variant: "today" | "week") =>
    groupQueueRows(rows).map((g) => renderFilmGroup(g, variant));

  const renderByPart = (rows: QueueRowData[], variant: "today" | "week") =>
    groupQueueRowsByPart(rows).map((pg) => (
      <div key={`part-${pg.key}`} style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#5B6472", marginBottom: 6 }}>
          🔧 {pg.partName} <Tag style={{ marginLeft: 4 }}>{pg.rows.length}</Tag>
        </div>
        {groupQueueRows(pg.rows).map((g) => renderFilmGroup(g, variant))}
      </div>
    ));

  const renderQueueRows = (rows: QueueRowData[], variant: "today" | "week") =>
    groupBy === "part" ? renderByPart(rows, variant) : renderByFilm(rows, variant);

  return (
    <div>
      <Space align="center" style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Выдача участку
        </Typography.Title>
        {(cuttingBatch.length > 0 || stockDecisions.length > 0) && (
          <Button size="small" type="primary" onClick={() => setCuttingBatchOpen(true)}>
            🕒 Решения ({cuttingBatch.length + stockDecisions.length})
          </Button>
        )}
        <Button size="small" onClick={() => setSlipModalOpen(true)}>
          📋 Сопроводительный лист
        </Button>
      </Space>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Запрошено сегодня" value={todayCount} valueStyle={{ color: "#C97A2B" }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small" style={overdueCount > 0 ? { background: "#FBEAE7", borderColor: "#E3B5AC" } : undefined}>
            <Statistic title="Просрочено" value={overdueCount} valueStyle={{ color: overdueCount > 0 ? "#B8483C" : undefined }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Строк не распределено на сегодня" value={weekRowsNeedingMaterial.length} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Участков ждут выдачи" value={areasWaiting} />
          </Card>
        </Col>
      </Row>

      {/* wrap + maxWidth:100% на каждом поле — раньше три поля с
          фиксированной шириной (220+320+200 = 740px) не помещались на
          телефоне ни в одну строку, ни по отдельности (поиск один шире
          самого экрана), и уезжали за правый край без переноса. */}
      <Space wrap size={[12, 12]} style={{ marginBottom: 16, width: "100%" }}>
        <Select
          allowClear
          placeholder="Все участки"
          style={{ width: 220, maxWidth: "100%" }}
          options={areaOptions}
          value={areaFilter}
          onChange={setAreaFilter}
        />
        <Select
          allowClear
          showSearch
          placeholder="Все задания"
          style={{ width: 260, maxWidth: "100%" }}
          options={taskOptions}
          optionFilterProp="label"
          value={taskFilter}
          onChange={setTaskFilter}
        />
        <Input.Search
          placeholder="Поиск по детали, заданию, плёнке…"
          style={{ width: 320, maxWidth: "100%" }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <DatePicker
          style={{ width: 200, maxWidth: "100%" }}
          format="DD.MM.YYYY"
          placeholder="Дата выдачи: сейчас"
          value={occurredAt}
          onChange={setOccurredAt}
          disabledDate={(d) => d.isAfter(dayjs(), "day")}
        />
        <Segmented
          value={groupBy}
          onChange={(v) => setGroupBy(v as "film" | "part")}
          options={[
            { label: "По плёнке", value: "film" },
            { label: "По детали", value: "part" },
          ]}
        />
      </Space>

      <Row gutter={[20, 20]}>
        <Col xs={24} lg={15}>
          <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Title level={5} style={{ margin: 0 }}>🔥 Запрошено сегодня</Typography.Title>
            <Tag>{filteredAssignmentRows.length}</Tag>
          </div>
          {filteredAssignmentRows.length === 0 ? (
            <Typography.Text type="secondary">Ничего не распределено на сегодня по выбранному фильтру.</Typography.Text>
          ) : (
            renderQueueRows(filteredAssignmentRows, "today")
          )}

          <div style={{ margin: "20px 0 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Title level={5} style={{ margin: 0 }}>📋 Не распределено на сегодня</Typography.Title>
            <Tag>{filteredWeekRows.length}</Tag>
          </div>
          {filteredWeekRows.length === 0 ? (
            <Typography.Text type="secondary">Остатка по заданиям, не распределённым на сегодня, нет.</Typography.Text>
          ) : (
            renderQueueRows(filteredWeekRows, "week")
          )}
        </Col>

        <Col xs={24} lg={9}>
          {/* Раздел про скролл на планшете — правая колонка растягивается
              по высоте левой (Row без align — дефолтный stretch), а
              position:sticky без своего overflow застревал наверху: пока
              не прокрутишь весь список слева, до конца содержимого
              справа было не добраться. Даём этому блоку собственный
              потолок высоты и прокрутку — sticky продолжает липнуть к
              верху при скролле страницы, а если содержимого больше, чем
              видно, оно скроллится само внутри, независимо от левой
              колонки. */}
          <div style={{ position: "relative" }}>
          <div
            ref={stickyPanelRef}
            onScroll={recomputeHasMoreBelow}
            style={{
              position: "sticky",
              top: 16,
              maxHeight: "calc(100vh - 140px)",
              overflowY: "auto",
              overscrollBehavior: "contain",
              paddingRight: 4,
            }}
          >
            {!selected && !lastIssued && (
              <Card style={{ textAlign: "center", padding: "24px 8px", color: "#8A8C99" }}>
                Выберите потребность слева — материал, штрипс и участок подставятся автоматически.
              </Card>
            )}

            {selected && !lastIssued && (
              <Card>
                <Typography.Title level={5}>{selected.line.part_name ?? "Деталь"}</Typography.Title>
                <table style={{ width: "100%", fontSize: 13, marginBottom: 14 }}>
                  <tbody>
                    <tr>
                      <td style={{ color: "#8A8C99", paddingRight: 12 }}>Задание</td>
                      <td style={{ fontWeight: 600 }}>
                        {selected.task.product_model_name ?? selected.task.name} · {areaLabel(selected.task.area)}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: "#8A8C99" }}>Плёнка</td>
                      <td style={{ fontWeight: 600 }}>
                        {selected.line.material}, {selected.line.color}, {selected.line.thickness} мм
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: "#8A8C99" }}>Штрипс</td>
                      <td style={{ fontWeight: 700, color: "#2C4A73" }}>{selectedStripWidth} мм</td>
                    </tr>
                    <tr>
                      <td style={{ color: "#8A8C99" }}>Длина на штрипс</td>
                      <td style={{ fontWeight: 600 }}>{selected.line.length_m} м</td>
                    </tr>
                    {selected.assignment && (
                      <tr>
                        <td style={{ color: "#8A8C99" }}>Смена</td>
                        <td style={{ fontWeight: 600 }}>
                          {dayjs(selected.assignment.date).format("DD.MM.YYYY")}, {selected.assignment.line_name}, {selected.assignment.employee_names}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {!selectedSku && (
                  <Typography.Text type="warning">
                    Такой номенклатуры материала нет в справочнике — выдача невозможна, обратитесь к начальнику склада.
                  </Typography.Text>
                )}

                {selectedSku && shortfallM2 > 0 && (
                  // message+action в один ряд (стандартный Alert) на узкой
                  // боковой панели планшета сжимал текст в колонку по
                  // одной букве — action всегда пытается влезть рядом с
                  // текстом. description+кнопка блоком друг под другом
                  // этого не делают ни при какой ширине.
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="Не хватает остатка на складе"
                    description={
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                        <span>
                          Не хватает ~{shortfallM2} м² на весь остаток строки — на складе{" "}
                          {Math.round(availableM2 * 100) / 100} м², нужно {Math.round(neededM2 * 100) / 100} м²
                        </span>
                        <Button size="small" type="primary" onClick={openShortageModal}>
                          Подать заявку на закупку
                        </Button>
                      </div>
                    }
                  />
                )}

                {(availableQuery.isLoading || findMutation.isPending) && (
                  <Typography.Text type="secondary">Подбираем штрипс…</Typography.Text>
                )}

                {exactMatch && (
                  <div style={{ background: "#E7F5EE", border: "1px solid #B7E0CD", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: "#146B4E" }}>Есть точный штрипс №{exactMatch.id}</div>
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>
                      {exactMatch.width_mm} мм × {exactMatch.length_m} м
                      {exactMatch.location_code ? ` · ${exactMatch.location_code}` : ""}
                    </div>
                    <Button
                      type="primary"
                      block
                      style={{ marginTop: 10 }}
                      loading={directMutation.isPending}
                      onClick={() =>
                        confirmIfWrongWarehouse(exactMatch.warehouse_name, selected?.task.area, () =>
                          directMutation.mutate({ unitId: exactMatch.id }),
                        )
                      }
                    >
                      Выдать
                    </Button>
                  </div>
                )}

                {result?.outcome === "not_found" && (
                  <div style={{ background: "#FBEAE7", border: "1px solid #E3B5AC", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: "#B8483C" }}>Точного штрипса и донора нет на своём складе</div>
                    {result.elsewhere_warehouse_name ? (
                      <>
                        <div style={{ fontSize: 12.5, color: "#8C4238", marginTop: 4 }}>
                          Материал есть на складе «{result.elsewhere_warehouse_name}» — подготовьте (нарежьте) там и отправьте
                          через «Перемещения между складами», затем выдайте уже с домашнего склада.
                        </div>
                        <Button size="small" style={{ marginTop: 8 }} onClick={() => navigate("/warehouse-transfers")}>
                          Перейти к перемещениям
                        </Button>
                      </>
                    ) : (
                      <div style={{ fontSize: 12.5, color: "#8C4238", marginTop: 4 }}>Режьте новый рулон вручную через карточку единицы.</div>
                    )}
                  </div>
                )}

                {result?.outcome === "donor_suggested" && result.donor && (
                  <div style={{ background: "#FBF0E3", border: "1px solid #ECC79B", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: "#A8631E" }}>
                      ⚡ Точного штрипса нет — есть донор №{result.donor.unit_id}
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>
                      {result.donor.width_mm} мм, класс{" "}
                      <Tooltip title="ABC по расходу: A — самые ходовые ширины (80% расхода), B — следующие до 95%, C — редкие, донор режут в первую очередь именно из C/B">
                        <span style={{ textDecoration: "underline dotted" }}>{result.donor.width_class}</span>
                      </Tooltip>
                      {result.donor.days_in_storage !== undefined && result.donor.days_in_storage > 0 && (
                        <Tag color="volcano" style={{ marginLeft: 6 }}>лежалый {result.donor.days_in_storage} дн.</Tag>
                      )}
                      <br />
                      Отрежем {result.donor.recommended_cut_mm} мм, отход {result.donor.waste_mm} мм.
                    </div>
                    <Button
                      type="primary"
                      block
                      style={{ marginTop: 10 }}
                      onClick={() => {
                        if (!selectedSku || !selected) return;
                        setCuttingSession({
                          donor: makeDonorUnit(
                            result.donor!.unit_id,
                            result.donor!.width_mm,
                            result.donor!.length_m,
                            result.donor!.warehouse_name,
                            selectedSku,
                          ),
                          widthCuts: [
                            {
                              width_mm: result.donor!.recommended_cut_mm,
                              area: selected.task.area,
                              production_task_line_id: selected.line.id,
                              label: selected.line.part_name ?? "Деталь",
                              locked: true,
                            },
                          ],
                          onDone: finishSingleCut,
                        });
                      }}
                    >
                      ⚡ Разрезать и выдать
                    </Button>
                  </div>
                )}

                <Collapse
                  ghost
                  size="small"
                  items={[
                    {
                      key: "stock",
                      label: `Показать остатки на складе по этой номенклатуре (${availableQuery.data?.length ?? 0})`,
                      children: (
                        <ResponsiveTable<MaterialUnit>
                          size="small"
                          rowKey="id"
                          loading={availableQuery.isLoading}
                          dataSource={availableQuery.data ?? []}
                          pagination={false}
                          scroll={{ x: "max-content" }}
                          locale={{ emptyText: "Ничего нет на хранении" }}
                          columns={[
                            { title: "№", dataIndex: "id" },
                            { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                            { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
                            {
                              title: "",
                              render: (_, u) =>
                                u.width_mm > selectedStripWidth ? (
                                  <Button
                                    size="small"
                                    onClick={() => {
                                      if (!selected) return;
                                      setCuttingSession({
                                        donor: u,
                                        widthCuts: [
                                          {
                                            width_mm: selectedStripWidth,
                                            area: selected.task.area,
                                            production_task_line_id: selected.line.id,
                                            label: selected.line.part_name ?? "Деталь",
                                            locked: true,
                                          },
                                        ],
                                        onDone: finishSingleCut,
                                      });
                                    }}
                                  >
                                    Разрезать на {selectedStripWidth} мм
                                  </Button>
                                ) : u.width_mm === selectedStripWidth ? (
                                  <Button
                                    size="small"
                                    type="primary"
                                    loading={directMutation.isPending}
                                    onClick={() => confirmIfWrongWarehouse(u.warehouse_name, selected?.task.area, () => directMutation.mutate({ unitId: u.id }))}
                                  >
                                    Выдать целиком
                                  </Button>
                                ) : (
                                  <Tag color="warning">уже {selectedStripWidth} мм больше</Tag>
                                ),
                            },
                          ]}
                        />
                      ),
                    },
                    ...(canOverrideMaterial
                      ? [
                          {
                            key: "substitute",
                            label: "🔁 Выдать другим материалом (замена)",
                            children: (
                              <Space direction="vertical" style={{ width: "100%" }} size="small">
                                <Typography.Text type="secondary">
                                  Если нужной номенклатуры сейчас не хватает — выберите другой материал/цвет/толщину; сервер
                                  запомнит замену прямо в строке задания.
                                </Typography.Text>
                                <Select
                                  showSearch
                                  allowClear
                                  style={{ width: "100%" }}
                                  placeholder="Материал, цвет, толщина"
                                  value={substituteSkuId}
                                  onChange={setSubstituteSkuId}
                                  options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
                                  filterOption={(input, option) =>
                                    (option?.label as string).toLowerCase().includes(input.toLowerCase())
                                  }
                                />
                                {substituteSku && (
                                  <ResponsiveTable<MaterialUnit>
                                    size="small"
                                    rowKey="id"
                                    loading={substituteAvailableQuery.isLoading}
                                    dataSource={substituteAvailableQuery.data ?? []}
                                    pagination={false}
                                    scroll={{ x: "max-content" }}
                                    locale={{ emptyText: "Ничего нет на хранении по этой номенклатуре" }}
                                    columns={[
                                      { title: "№", dataIndex: "id" },
                                      { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                                      { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
                                      {
                                        title: "",
                                        render: (_, u) =>
                                          u.width_mm > selectedStripWidth ? (
                                            <Button
                                              size="small"
                                              onClick={() => {
                                                if (!selected) return;
                                                setCuttingSession({
                                                  donor: u,
                                                  widthCuts: [
                                                    {
                                                      width_mm: selectedStripWidth,
                                                      area: selected.task.area,
                                                      production_task_line_id: selected.line.id,
                                                      label: selected.line.part_name ?? "Деталь",
                                                      locked: true,
                                                    },
                                                  ],
                                                  onDone: finishSingleCut,
                                                });
                                              }}
                                            >
                                              Разрезать на {selectedStripWidth} мм
                                            </Button>
                                          ) : u.width_mm === selectedStripWidth ? (
                                            <Button
                                              size="small"
                                              type="primary"
                                              loading={directMutation.isPending}
                                              onClick={() =>
                                                confirmIfWrongWarehouse(u.warehouse_name, selected?.task.area, () =>
                                                  directMutation.mutate({ unitId: u.id, override: true }),
                                                )
                                              }
                                            >
                                              Выдать целиком
                                            </Button>
                                          ) : (
                                            <Tag color="warning">меньше нужной ширины ({selectedStripWidth} мм)</Tag>
                                          ),
                                      },
                                    ]}
                                  />
                                )}
                              </Space>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              </Card>
            )}

            {lastIssued && (
              <Card style={{ background: "#E7F5EE", borderColor: "#B7E0CD" }}>
                <Space align="center" style={{ marginBottom: 4 }}>
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: "#1D9E75",
                      color: "#fff",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ✓
                  </span>
                  <Typography.Text strong style={{ color: "#146B4E", fontSize: 15 }}>
                    Выдано №{lastIssued.unit.id} — {lastIssued.unit.width_mm} мм × {lastIssued.unit.length_m} м
                  </Typography.Text>
                </Space>
                {lastIssued.remainder && (
                  <div style={{ marginLeft: 40, fontSize: 12.5, color: "#2E6B54", marginBottom: 14 }}>
                    Донор разрезан, остаток №{lastIssued.remainder.id} обновлён
                  </div>
                )}

                <Space direction="vertical" style={{ width: "100%", marginTop: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "#fff",
                      border: "1px solid #C7E5D6",
                      borderRadius: 9,
                      padding: "10px 12px",
                    }}
                  >
                    <span>🏷️ Бирка на выданный штрипс</span>
                    <Button size="small" onClick={() => printLabel(lastIssued.unit.id)}>Печать</Button>
                  </div>

                  {lastIssued.remainder && !lastIssued.remainderPlaced && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        background: "#fff",
                        border: "1px solid #C7E5D6",
                        borderRadius: 9,
                        padding: "10px 12px",
                      }}
                    >
                      <span>
                        📦 Остаток №{lastIssued.remainder.id}, {lastIssued.remainder.width_mm} мм
                        {remainderSuggestion.data && (
                          <>
                            {" — рекомендуем "}
                            <Tag color="orange">{remainderSuggestion.data}</Tag>
                          </>
                        )}
                      </span>
                      <Button
                        size="small"
                        type="primary"
                        disabled={!remainderSuggestion.data}
                        loading={placeRemainderMutation.isPending}
                        onClick={() => placeRemainderMutation.mutate(remainderSuggestion.data!)}
                      >
                        Разместить
                      </Button>
                    </div>
                  )}
                  {lastIssued.remainder && lastIssued.remainderPlaced && (
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      Остаток размещён.
                    </Typography.Text>
                  )}
                </Space>

                <Button block style={{ marginTop: 14 }} onClick={finishAndReset}>
                  Готово — к следующей позиции
                </Button>
              </Card>
            )}

            <Collapse
              ghost
              style={{ marginTop: 12 }}
              items={[
                {
                  key: "manual",
                  label: "Без привязки к заданию (ручной подбор)",
                  children: (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                        Для случаев, когда плёнка не относится ни к одному заданию — проба, списание и т.п. Строгая
                        проверка соответствия здесь не действует.
                      </Typography.Text>
                      <Select
                        showSearch
                        style={{ width: "100%" }}
                        placeholder="Позиция материала"
                        loading={manualSkusQuery.isLoading}
                        options={(manualSkusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
                        filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
                        value={manualSkuId ?? undefined}
                        onChange={(v) => {
                          setManualSkuId(v);
                          setManualDonor(null);
                        }}
                      />
                      <Select
                        style={{ width: "100%" }}
                        placeholder="Участок выдачи"
                        options={areaOptions}
                        value={manualArea ?? undefined}
                        onChange={(v) => setManualArea(v)}
                      />
                      {manualSku && (
                        <>
                          <ResponsiveTable<MaterialUnit>
                            size="small"
                            rowKey="id"
                            loading={manualAvailableQuery.isLoading}
                            dataSource={manualAvailableQuery.data ?? []}
                            pagination={false}
                            scroll={{ x: "max-content" }}
                            locale={{ emptyText: "Ничего нет на хранении" }}
                            columns={[
                              { title: "№", dataIndex: "id" },
                              { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                              { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
                              {
                                title: "",
                                render: (_, u) => (
                                  <Button
                                    size="small"
                                    type="primary"
                                    disabled={!manualArea}
                                    loading={manualDirectMutation.isPending}
                                    onClick={() =>
                                      confirmIfWrongWarehouse(u.warehouse_name, manualArea, () => manualDirectMutation.mutate(u.id))
                                    }
                                  >
                                    Выдать целиком
                                  </Button>
                                ),
                              },
                            ]}
                          />
                          <Form form={manualForm} layout="inline" onFinish={(v) => manualFindMutation.mutate(v)}>
                            <Form.Item name="width_mm" rules={[{ required: true }]}>
                              <InputNumber placeholder="Ширина, мм" min={1} style={{ width: 120 }} />
                            </Form.Item>
                            <Form.Item name="length_m" rules={[{ required: true }]}>
                              <InputNumber placeholder="Длина, м" min={0.1} step={0.1} style={{ width: 120 }} />
                            </Form.Item>
                            <Button htmlType="submit" disabled={!manualArea} loading={manualFindMutation.isPending}>
                              Найти и выдать
                            </Button>
                          </Form>
                          {manualElsewhere && (
                            <div style={{ background: "#FBEAE7", border: "1px solid #E3B5AC", borderRadius: 10, padding: 12 }}>
                              <div style={{ fontWeight: 700, color: "#B8483C" }}>Материал есть на другом складе</div>
                              <div style={{ fontSize: 12.5, color: "#8C4238", marginTop: 4 }}>
                                Есть на складе «{manualElsewhere}» — подготовьте (нарежьте) там и отправьте через «Перемещения
                                между складами», затем выдайте уже с домашнего склада.
                              </div>
                              <Button size="small" style={{ marginTop: 8 }} onClick={() => navigate("/warehouse-transfers")}>
                                Перейти к перемещениям
                              </Button>
                            </div>
                          )}
                          {manualDonor && (
                            <div style={{ background: "#FBF0E3", border: "1px solid #ECC79B", borderRadius: 10, padding: 12 }}>
                              <div style={{ fontWeight: 700, color: "#A8631E" }}>
                                ⚡ Точного совпадения нет — есть донор №{manualDonor.unit_id}
                              </div>
                              <div style={{ fontSize: 12.5, marginTop: 4 }}>
                                {manualDonor.width_mm} мм, класс{" "}
                                <Tooltip title="ABC по расходу: A — самые ходовые ширины (80% расхода), B — следующие до 95%, C — редкие, донор режут в первую очередь именно из C/B">
                                  <span style={{ textDecoration: "underline dotted" }}>{manualDonor.width_class}</span>
                                </Tooltip>
                                {manualDonor.days_in_storage !== undefined && manualDonor.days_in_storage > 0 && (
                                  <Tag color="volcano" style={{ marginLeft: 6 }}>лежалый {manualDonor.days_in_storage} дн.</Tag>
                                )}
                                <br />
                                Отрежем {manualDonor.recommended_cut_mm} мм, отход {manualDonor.waste_mm} мм.
                              </div>
                              <Button
                                type="primary"
                                block
                                style={{ marginTop: 10 }}
                                disabled={!manualArea}
                                onClick={() => {
                                  if (!manualSku || !manualArea) return;
                                  setCuttingSession({
                                    donor: makeDonorUnit(
                                      manualDonor.unit_id,
                                      manualDonor.width_mm,
                                      manualDonor.length_m,
                                      manualDonor.warehouse_name,
                                      manualSku,
                                    ),
                                    widthCuts: [
                                      {
                                        width_mm: manualDonor.recommended_cut_mm,
                                        area: manualArea,
                                        label: "Ручной подбор",
                                        locked: false,
                                      },
                                    ],
                                    onDone: (res) => {
                                      finishSingleCut(res);
                                      setManualDonor(null);
                                      qc.invalidateQueries({ queryKey: ["issue-manual-available"] });
                                    },
                                  });
                                }}
                              >
                                ⚡ Разрезать и выдать
                              </Button>
                            </div>
                          )}
                        </>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </div>
          {hasMoreBelow && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 4,
                bottom: 0,
                height: 20,
                pointerEvents: "none",
                background: "linear-gradient(rgba(255,255,255,0), rgba(255,255,255,0.95))",
              }}
            />
          )}
          </div>
        </Col>
      </Row>

      {issuedLines.length > 0 && (
        <Card style={{ marginTop: 20 }} title="📦 Выдано по заданиям — расход плёнки">
          <ResponsiveTable
            tableKey="issue-issued-lines"
            lockedColumns={["Задание"]}
            defaultHiddenColumns={["Деталь", "Плёнка", "Остаток задания, шт"]}
            size="small"
            rowKey={(r) => r.line.id}
            dataSource={issuedLines}
            pagination={{ pageSize: 10 }}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Задание", render: (_, r) => r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}` },
              { title: "Деталь", render: (_, r) => r.line.part_name ?? "—" },
              { title: "Участок", render: (_, r) => areaLabel(r.task.area) },
              { title: "Плёнка", render: (_, r) => `${r.line.material}, ${r.line.color}, ${r.line.thickness} мм` },
              { title: "Выдано, м", render: (_, r) => r.line.issued_length_m.toFixed(1) },
              { title: "Хороших, шт", render: (_, r) => <Tag color="green">{r.line.produced_good_pieces}</Tag> },
              {
                title: "Брак, шт",
                render: (_, r) => (r.line.defect_pieces > 0 ? <Tag color="red">{r.line.defect_pieces}</Tag> : "—"),
              },
              { title: "Остаток задания, шт", render: (_, r) => r.line.remaining_pieces },
              {
                title: "Действия",
                render: (_, r) =>
                  r.line.issued_units.length > 0 && (
                    <Space direction="vertical" size={4}>
                      <a
                        onClick={() =>
                          printLabelsBatch(
                            r.line.issued_units.map((u) => u.id),
                            { kind: "cutting_issue" },
                          )
                        }
                      >
                        печать наклеек ({r.line.issued_units.length})
                      </a>
                      {canReturn && r.line.issued_units.map((u) => <AcceptReturnButton key={u.id} unit={u} />)}
                    </Space>
                  ),
              },
            ]}
          />
        </Card>
      )}

      {manualIssuedUnits.length > 0 && (
        <Card style={{ marginTop: 20 }} title={`📦 Выдано вручную — ${manualIssuedUnits.length}`}>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, marginBottom: 12 }}>
            Единицы, выданные без привязки к заданию (ручной подбор) — сюда же попадает возврат,
            без задания это не отслеживается в "Выдано по заданиям" выше.
          </Typography.Paragraph>
          <ResponsiveTable
            tableKey="issue-manual-issued"
            size="small"
            rowKey="id"
            loading={manualIssuedQuery.isLoading}
            dataSource={manualIssuedUnits}
            pagination={{ pageSize: 10 }}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "№", dataIndex: "id" },
              { title: "Плёнка", render: (_, u) => skuLabel(u.material_sku) },
              { title: "Участок", render: (_, u) => (u.area ? areaLabel(u.area) : "—") },
              { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
              {
                title: "",
                render: (_, u) =>
                  canReturn && (
                    <Space>
                      <a onClick={() => printLabel(u.id, { kind: "cutting_issue" })}>печать</a>
                      <AcceptReturnButton
                        unit={{
                          id: u.id,
                          width_mm: u.width_mm,
                          length_m: u.length_m,
                          material_sku_id: u.material_sku.id,
                          parent_id: u.parent_id,
                          is_strip: u.is_strip,
                          status: u.status,
                        }}
                      />
                    </Space>
                  ),
              },
            ]}
          />
        </Card>
      )}

      <Modal
        title="Заявка на закупку — с цеха"
        open={shortageModalOpen}
        onCancel={() => setShortageModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={shortageForm}
          onFinish={(v) => shopFloorRequestMutation.mutate(v)}
        >
          <Form.Item name="material" label="Материал">
            <Input disabled />
          </Form.Item>
          <Form.Item name="color" label="Цвет">
            <Input disabled />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм">
            <InputNumber disabled style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="requested_area_m2" label="Запросить, м²" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="note" label="Комментарий">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={shopFloorRequestMutation.isPending}>
            Отправить заявку
          </Button>
        </Form>
      </Modal>

      {cuttingSession && (
        <Modal
          title={`Резать донора №${cuttingSession.donor.id}`}
          open
          onCancel={() => setCuttingSession(null)}
          footer={null}
          destroyOnHidden
          width={560}
        >
          <CuttingForm
            donor={cuttingSession.donor}
            initialWidthCuts={cuttingSession.widthCuts}
            areaOptions={areaOptions}
            confirmDestination={confirmIfWrongWarehouse}
            onDone={cuttingSession.onDone}
            onCancel={() => setCuttingSession(null)}
          />
        </Modal>
      )}

      <Modal
        title="Решения по выдаче и резке"
        open={cuttingBatchOpen}
        onCancel={() => setCuttingBatchOpen(false)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Ничего из этого ещё не выполнено физически — решения только
          накоплены. «Выполнить всё» разом выдаст со склада и разрежет
          доноров; «Печать» — план для резчиков (сами доноры и раскрой уже
          решены здесь, резчики только режут по листу).
        </Typography.Paragraph>

        {stockDecisions.length > 0 && (
          <>
            <Typography.Title level={5} style={{ marginTop: 8 }}>
              Выдать со склада
            </Typography.Title>
            <ResponsiveTable
              tableKey="stock-decisions"
              rowKey={(r) => r.lineId}
              size="small"
              pagination={false}
              dataSource={stockDecisions}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "№ штрипса", render: (_, r) => r.unitId },
                { title: "Ширина, мм", render: (_, r) => r.widthMm },
                { title: "Деталь", render: (_, r) => r.label },
                { title: "Участок", render: (_, r) => areaLabel(r.area) },
                {
                  title: "",
                  render: (_, r) => (
                    <Button size="small" danger onClick={() => removeStockDecision(r.lineId)}>
                      Убрать
                    </Button>
                  ),
                },
              ]}
            />
          </>
        )}

        {cuttingBatch.length > 0 && (
          <>
            <Typography.Title level={5} style={{ marginTop: 16 }}>
              Резать
            </Typography.Title>
            <ResponsiveTable
              tableKey="cutting-batch"
              rowKey={(r) => `${r.entry.donorUnitId}-${r.widthMm}-${r.label}`}
              size="small"
              pagination={false}
              dataSource={cuttingBatch.flatMap((e) => e.pieces.map((p) => ({ ...p, entry: e })))}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "№ рулона/штрипса", render: (_, r) => r.entry.donorUnitId },
                { title: "Ширина рулона, мм", render: (_, r) => r.entry.donorWidthMm },
                { title: "Длина рулона, м", render: (_, r) => r.entry.donorLengthM },
                { title: "Ширина реза, мм", render: (_, r) => r.widthMm },
                { title: "Деталь/задание", render: (_, r) => r.label },
                { title: "Участок", render: (_, r) => areaLabel(r.area) },
                { title: "Место хран. остатка", render: (_, r) => r.entry.remainderLocationCode ?? "—" },
                { title: "Отход, мм", render: (_, r) => r.entry.wasteMm },
                {
                  title: "",
                  render: (_, r) => (
                    <Button size="small" danger onClick={() => removeFromCuttingBatch(r.entry.donorUnitId)}>
                      Убрать
                    </Button>
                  ),
                },
              ]}
            />
          </>
        )}

        {stockDecisions.length === 0 && cuttingBatch.length === 0 ? (
          <Typography.Text type="secondary">Список решений пуст.</Typography.Text>
        ) : (
          <Space style={{ marginTop: 16 }} wrap>
            <Button type="primary" loading={executingAll} onClick={executeAllDecisions}>
              ✅ Выполнить всё ({cuttingBatch.length + stockDecisions.length})
            </Button>
            {cuttingBatch.length > 0 && (
              <Button
                onClick={() =>
                  printReport(
                    "Список на резку",
                    [
                      { key: "donor", header: "№ рулона/штрипса" },
                      { key: "donorWidth", header: "Ширина рулона, мм" },
                      { key: "donorLength", header: "Длина рулона, м" },
                      { key: "width", header: "Ширина реза, мм" },
                      { key: "label", header: "Деталь/задание" },
                      { key: "area", header: "Участок" },
                      { key: "remainder", header: "Место хран. остатка" },
                      { key: "waste", header: "Отход, мм" },
                    ],
                    cuttingBatch.flatMap((e) =>
                      e.pieces.map((p) => ({
                        donor: e.donorUnitId,
                        donorWidth: e.donorWidthMm,
                        donorLength: e.donorLengthM,
                        width: p.widthMm,
                        label: p.label,
                        area: areaLabel(p.area),
                        remainder: e.remainderLocationCode ?? "—",
                        waste: e.wasteMm,
                      })),
                    ),
                  )
                }
              >
                🖨 Печать списка на резку
              </Button>
            )}
            <Button
              danger
              onClick={() => {
                setCuttingBatch([]);
                setStockDecisions([]);
              }}
            >
              Очистить всё
            </Button>
          </Space>
        )}
      </Modal>

      <Modal title="Сопроводительный лист" open={slipModalOpen} onCancel={() => setSlipModalOpen(false)} footer={null} destroyOnHidden>
        <Typography.Paragraph type="secondary">
          По одному заданию за раз — деталь/количество/материал и явный номер
          рулона/штрипса против каждой (реальный, если уже выдано/разрезано;
          номер донора с пометкой «план», если решение принято, но резка ещё
          не выполнена).
        </Typography.Paragraph>
        <Space wrap>
          <Select
            style={{ width: 280 }}
            placeholder="Выберите задание"
            options={taskOptions}
            optionFilterProp="label"
            showSearch
            value={slipTaskId}
            onChange={setSlipTaskId}
          />
          <Button
            type="primary"
            disabled={!slipTaskId}
            onClick={() => {
              const task = tasksQuery.data?.find((t) => t.id === slipTaskId);
              if (task) printFactorySlip(task);
            }}
          >
            🖨 Печать
          </Button>
        </Space>
      </Modal>
    </div>
  );
}

/** Приём возврата прямо в «Выдано по заданиям» — там же, где плёнку
 * выдавали, а не в отдельной карточке единицы (раздел про единый процесс
 * возврата). Длина остатка по расчёту (хорошие и брак за смену уже
 * учтены) прописывается автоматически — вводить/поправлять число негде.
 * Диалог сразу же предлагает место по правилу зонирования (если оно
 * есть) и позволяет указать полку вручную — приём и размещение одним
 * действием, а не отдельным походом на «Стеллажи → Без места». */
function AcceptReturnButton({ unit }: { unit: ProductionTaskLineIssuedUnit }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" type="primary" onClick={() => setOpen(true)}>
        Принять №{unit.id}
      </Button>
      {open && <AcceptReturnModal unit={unit} onClose={() => setOpen(false)} />}
    </>
  );
}

function AcceptReturnModal({ unit, onClose }: { unit: ProductionTaskLineIssuedUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const [locationCode, setLocationCode] = useState("");
  const [locationTouched, setLocationTouched] = useState(false);
  const [occurredAt, setOccurredAt] = useState<Dayjs | null>(null);

  const previewQuery = useQuery({ queryKey: ["return-preview", unit.id], queryFn: () => getReturnPreview(unit.id) });
  const suggestionQuery = useQuery({
    queryKey: ["suggest-location", "accept-return", unit.id],
    queryFn: () => suggestLocation({ material_sku_id: unit.material_sku_id, is_strip: unit.is_strip }),
  });

  useEffect(() => {
    if (suggestionQuery.data && !locationTouched) setLocationCode(suggestionQuery.data);
  }, [suggestionQuery.data, locationTouched]);

  const expected = previewQuery.data?.expected_return_length_m;
  const [actualLength, setActualLength] = useState<number | null>(null);
  const [lengthTouched, setLengthTouched] = useState(false);

  useEffect(() => {
    if (!lengthTouched) setActualLength(expected ?? unit.length_m);
  }, [expected, unit.length_m, lengthTouched]);

  const acceptMutation = useMutation({
    mutationFn: async () => {
      const occurredAtIso = toOccurredAtIso(occurredAt);
      const returned = await returnUnit(unit.id, {
        actual_length_m: actualLength ?? expected ?? unit.length_m,
        occurred_at: occurredAtIso,
      });
      if (locationCode.trim()) await placeUnit(returned.id, locationCode.trim(), occurredAtIso);
      return { returned, placed: !!locationCode.trim() };
    },
    onSuccess: ({ returned, placed }) => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["units-unplaced"] });
      qc.invalidateQueries({ queryKey: ["rack-occupancy"] });
      qc.invalidateQueries({ queryKey: ["issue-manual-issued"] });
      message.success(
        <>
          №{returned.id} принят{placed ? ` и размещён: ${locationCode.trim()}` : ""} —{" "}
          <a onClick={() => printLabel(returned.id, { kind: "cutting_issue" })}>печать бирки</a>
        </>,
      );
      onClose();
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось принять возврат")),
  });

  return (
    <Modal title={`Принять №${unit.id} на склад`} open onCancel={onClose} footer={null} destroyOnHidden>
      {expected != null ? (
        <Alert
          style={{ marginBottom: 8 }}
          type="info"
          showIcon
          message={`Остаток по расчёту: ${expected} м (хорошие и брак уже учтены) — поправьте ниже, если обмер показал другое.`}
        />
      ) : (
        !previewQuery.isLoading && (
          <Alert
            style={{ marginBottom: 8 }}
            type="warning"
            showIcon
            message="Расчёт остатка недоступен — впишите фактическую длину вручную."
          />
        )
      )}
      <Typography.Text strong>Фактическая длина остатка, м</Typography.Text>
      <InputNumber
        style={{ width: "100%", marginTop: 8, marginBottom: 16 }}
        min={0}
        step={0.1}
        value={actualLength}
        onChange={(v) => {
          setLengthTouched(true);
          setActualLength(v);
        }}
      />

      {suggestionQuery.isLoading ? null : suggestionQuery.data ? (
        <Alert style={{ marginBottom: 8 }} type="success" showIcon message={`По правилу зонирования подходит: ${suggestionQuery.data}`} />
      ) : (
        <Alert style={{ marginBottom: 8 }} type="warning" showIcon message="Нет подходящего правила зонирования — укажите полку вручную" />
      )}
      <Typography.Text strong>Куда поместить остаток (необязательно)</Typography.Text>
      <Input
        style={{ marginTop: 8, marginBottom: 16 }}
        placeholder="Например, Ш-1-04 — оставьте пустым, если пока не знаете"
        value={locationCode}
        onChange={(e) => {
          setLocationTouched(true);
          setLocationCode(e.target.value);
        }}
      />
      <DatePicker
        style={{ width: "100%", marginBottom: 16 }}
        format="DD.MM.YYYY"
        placeholder="Дата возврата: сейчас"
        value={occurredAt}
        onChange={setOccurredAt}
        disabledDate={(d) => d.isAfter(dayjs(), "day")}
      />

      <Button
        type="primary"
        block
        loading={acceptMutation.isPending}
        disabled={actualLength == null}
        onClick={() => acceptMutation.mutate()}
      >
        {locationCode.trim() ? "Принять и разместить" : "Принять без места"}
      </Button>
      <Button block style={{ marginTop: 8 }} onClick={onClose}>
        Отмена
      </Button>
    </Modal>
  );
}
