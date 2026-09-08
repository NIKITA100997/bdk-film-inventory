import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  Select,
  Space,
  Table,
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
import ActionIcon from "../../components/ActionIcon";
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
  closeTaskLine,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineAssignment,
  type ProductionTaskLineIssuedUnit,
} from "../../api/production";
import ResponsiveTable from "../../components/ResponsiveTable";
import CuttingForm, { type CuttingFormInitialWidthCut } from "../../components/CuttingForm";
import ManualCuttingPlanModal from "../../components/ManualCuttingPlanModal";
import { useAuth } from "../../auth/AuthContext";
import { listWidthAnalogGroups, isWidthMatch } from "../../api/widthAnalogs";

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

// Раздел про кнопки действий прямо в строке (не только в развороте) —
// статус для колонки "Статус" + готовые к вызову действия для колонки
// "Действия", посчитанные один раз репортёром группы (GroupStatusReporter)
// и переиспользуемые и таблицей, и панелью решения в развороте.
interface RowInfo {
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
type StatusFilterValue = "issued" | "stock" | "cut" | "no_donor" | "decided" | "manual";

const statusFilterOptions: { value: StatusFilterValue; label: string }[] = [
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
interface NeedTableRow {
  kind: "need";
  key: string;
  task: ProductionTask;
  line: ProductionTaskLine;
  assignment?: ProductionTaskLineAssignment;
  overdue?: boolean;
  variant: "today" | "week";
}
interface ManualTableRow {
  kind: "manual";
  key: string;
  unit: MaterialUnit;
}
type TableRow = NeedTableRow | ManualTableRow;

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
function useGroupCuttingPlan(sku: MaterialSku | undefined, rows: QueueRowData[]) {
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

/** "Невидимый" репортёр — один экземпляр на группу, смонтирован ВСЕГДА
 * (не только когда строка развёрнута), чтобы и колонка "Статус", и
 * колонка "Действия" в таблице знали актуальное состояние каждой строки
 * без необходимости её открывать — кнопки "Использовать"/"+ В резку"
 * нужны прямо в строке, не только в развороте. Сам ничего не рендерит —
 * пишет результат (статус + готовые к вызову действия) в общий стейт
 * lineInfoMap в Issue(). */
function GroupStatusReporter({
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
function GroupDecisionPanel({
  sku,
  rows,
  onOpenManualPicker,
}: {
  sku: MaterialSku | undefined;
  rows: QueueRowData[];
  onOpenManualPicker: () => void;
}) {
  const planQuery = useGroupCuttingPlan(sku, rows);
  const manualLink = <a onClick={onOpenManualPicker}>🔧 Свой донор и раскрой</a>;

  if (!sku || !planQuery.data) return <Typography.Text type="secondary">Подбираем план резки…</Typography.Text>;
  const { donor, covered_widths_mm, uncovered_widths_mm, waste_mm } = planQuery.data;

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
      ✂️ План резки: донор №{donor.unit_id} ({donor.width_mm} мм, {donor.length_m} м) → режем{" "}
      {covered_widths_mm.join(" + ")} мм, отход {waste_mm} мм
      {uncovered_widths_mm.length > 0 && <> · ещё нет донора на {uncovered_widths_mm.join(", ")} мм</>}
      {" · "}
      {manualLink}
    </Typography.Text>
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
  // Раздел про закрытие строки задания по выдаче — то же право, что и
  // override материала выше (управленческое решение, не рутинная выдача
  // складом); отдельное имя здесь только для ясности у места вызова.
  const canManage = canOverrideMaterial;
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
  // Раздел про фильтр по статусу — та же категория, что показывает пилюля
  // в колонке «Статус»/иконка в «Действиях», просто вынесенная в
  // отдельный выбор сверху, чтобы не листать все строки в поиске одного
  // конкретного состояния (например, только «нет донора» на смену).
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue | undefined>(undefined);
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

  // Раздел про кнопки действий прямо в строке — статус + готовые
  // действия по каждой строке (по line.id), собранные из всех
  // GroupStatusReporter на странице (один на группу материал+цвет+
  // толщина+участок). Мержится вглубь — репортёр каждой группы пишет
  // только свои строки, не трогая чужие.
  const [lineInfoMap, setLineInfoMap] = useState<Map<number, RowInfo>>(new Map());
  const reportGroupInfos = (infos: Map<number, RowInfo>) =>
    setLineInfoMap((prev) => {
      const next = new Map(prev);
      infos.forEach((v, k) => next.set(k, v));
      return next;
    });
  // Раздел про кнопки действий прямо в строке — "Свой донор и раскрой"
  // раньше открывался из панели решения в развороте (своя модалка на
  // группу); теперь одна общая модалка на всю страницу, чтобы кнопка в
  // колонке "Действия" могла её открыть без разворота строки.
  const [manualPickerTarget, setManualPickerTarget] = useState<{ sku: MaterialSku; rows: QueueRowData[] } | null>(null);
  // Раздел про действия кнопками в строке — раскрывающийся список убран
  // целиком (был лишним: печать/приёмка возврата уже кнопки в строке,
  // Использовать/+ В резку/Свой донор — тоже). Осталось ровно одно, что
  // не сводится к кнопке в узкой колонке — полный разбор строки (точное
  // совпадение/донор/замена материала/донор+раскрой группы) — теперь
  // модалка "Подробнее", а не разворот таблицы.
  const [detailRow, setDetailRow] = useState<NeedTableRow | null>(null);

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
  // Раздел про аналоги ширин при выдаче — редко меняются, грузим один раз
  // на весь экран и используем во всех местах ручного подбора донора, для
  // визуальной консистентности с бэкендом (тот уже принимает аналог как
  // совпадение без override_strip_width, см. _validate_matches_task_line).
  const widthAnalogsQuery = useQuery({ queryKey: ["width-analogs"], queryFn: listWidthAnalogGroups });
  const widthAnalogGroups = widthAnalogsQuery.data ?? [];
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
  // Раздел про разбор задания единой таблицей — второе расширение
  // условия (после снятия shortfall_length_m > 0): строка с
  // remaining_pieces <= 0 (производство полностью завершено), но
  // issued_length_m > 0 (что-то по ней когда-то выдавалось), раньше жила
  // ТОЛЬКО в отдельной таблице "Выдано по заданиям" внизу экрана —
  // теперь остаётся прямо в очереди, той же строкой, статусом "выдано"
  // (issuedNoteForLine), просто ничего по ней уже не нужно решать.
  // Строка без остатка и без единой выдачи (пустая, ничего не было и
  // не нужно) по-прежнему не показывается — реального смысла в ней нет.
  const activeLines = useMemo(
    () =>
      (tasksQuery.data ?? [])
        .filter((task) => task.is_active)
        .flatMap((task) =>
          task.lines
            // is_closed — раздел про закрытие строки задания по выдаче:
            // ручной флаг поверх остатка/выданного, для строк, где всё уже
            // физически улажено вне этого экрана, а отчёты дозаводятся
            // только сейчас (issued_length_m сам по себе не уменьшается).
            .filter((line) => !line.is_closed && (line.remaining_pieces > 0 || line.issued_length_m > 0))
            .map((line) => ({ task, line })),
        ),
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
      (u) => isWidthMatch(widthAnalogGroups, u.width_mm, selectedStripWidth) && u.length_m >= selectedNeededLengthM,
    );
    if (candidates.length === 0) return null;
    // Точное совпадение раньше аналога — тот же приоритет, что и у
    // бэкенда (find_exact_stock_match), потом уже по длине.
    return [...candidates].sort((a, b) => {
      const aExact = a.width_mm === selectedStripWidth ? 0 : 1;
      const bExact = b.width_mm === selectedStripWidth ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.length_m - b.length_m;
    })[0];
  }, [selected, availableQuery.data, selectedStripWidth, selectedNeededLengthM, widthAnalogGroups]);

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

  // Раздел про закрытие строки задания по выдаче — строка, по которой всё
  // уже физически улажено (выдано/возвращено/списано) вне этого экрана,
  // а отчёты дозаводятся только сейчас, иначе висела бы в "Выдано по
  // заданиям" бессрочно (issued_length_m не уменьшается никогда).
  const closeLineMutation = useMutation({
    mutationFn: ({ taskId, lineId, isClosed }: { taskId: number; lineId: number; isClosed: boolean }) =>
      closeTaskLine(taskId, lineId, isClosed),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success("Строка закрыта по выдаче");
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось закрыть строку")),
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

  // Та же категоризация, что renderStatusPill превращает в пилюлю —
  // нужна отдельно (без JSX), чтобы фильтр по статусу сверху совпадал
  // буквально с тем, что видно в колонке "Статус".
  const rowStatusKind = (row: TableRow): StatusFilterValue | undefined => {
    if (row.kind === "manual") return "manual";
    if (issuedNoteForLine(row.line)) return "issued";
    if (decidedLineIds.has(row.line.id)) return "decided";
    switch (lineInfoMap.get(row.line.id)?.status.kind) {
      case "stock":
        return "stock";
      case "cut_planned":
        return "cut";
      case "no_donor":
        return "no_donor";
      default:
        return undefined;
    }
  };

  const renderStatusPill = (status: RowStatus | undefined, issuedNote: string | null) => {
    if (issuedNote) return <Tag color="green">{issuedNote}</Tag>;
    if (!status) return null;
    switch (status.kind) {
      case "stock":
        return <Tag color="green">✅ №{status.match.unit_id}</Tag>;
      case "cut_planned":
        return <Tag color="gold">✂️ резка</Tag>;
      case "no_donor":
        return <Tag color="red">✖ нет</Tag>;
      case "decided":
        return <Tag color="processing">🕒 решено</Tag>;
      default:
        return null;
    }
  };

  // Раздел про разбор задания единой таблицей — единая плотная таблица
  // вместо карточек: нужды по заданиям (assignmentRows/weekRows, включая
  // уже выданные — см. activeLines) плюс единицы, выданные без привязки
  // к заданию (manualIssuedUnits) — тем же способом, что раньше показывали
  // две отдельные таблицы внизу экрана ("Выдано по заданиям"/"Выдано
  // вручную"), теперь просто ещё строки этой же таблицы.
  const needTableRows: NeedTableRow[] = [
    ...filteredAssignmentRows.map((r) => ({
      kind: "need" as const,
      key: `need-${r.line.id}-${r.assignment.id}`,
      ...r,
      variant: "today" as const,
    })),
    ...filteredWeekRows.map((r) => ({
      kind: "need" as const,
      key: `need-${r.line.id}-week`,
      ...r,
      variant: "week" as const,
    })),
  ];
  const manualTableRows: ManualTableRow[] = manualIssuedUnits.map((u) => ({ kind: "manual" as const, key: `manual-${u.id}`, unit: u }));
  const tableRows: TableRow[] = [...needTableRows, ...manualTableRows];
  // Фильтр по статусу — только на отображение; cuttingRows ниже считается
  // из needTableRows ДО этого фильтра, чтобы скрытие, скажем, уже решённых
  // строк не меняло состав группы для подбора донора по остальным.
  const filteredTableRows = statusFilter ? tableRows.filter((r) => rowStatusKind(r) === statusFilter) : tableRows;

  // Группы для подбора донора — только строки с реальной нехваткой
  // (shortfall_length_m > 0); уже выданные строки не должны попадать в
  // подбор донора вообще (их "нужная" длина — 0, испортило бы точное
  // совпадение фиктивным "нужно 0 м"). groupQueueRows группирует по
  // участку+материалу+цвету+толщине, включая группы из одной строки —
  // GroupStatusReporter/GroupDecisionPanel одинаково работают с любым
  // размером группы (см. пояснение в get_cutting_plan на бэкенде).
  const cuttingRows = needTableRows.filter((r) => r.line.shortfall_length_m > 0);
  const cuttingGroups = groupQueueRows(cuttingRows);
  const groupRowsByRowKey = new Map<string, QueueRowData[]>();
  for (const g of cuttingGroups) for (const r of g.rows) groupRowsByRowKey.set(`need-${r.line.id}-${r.assignment?.id ?? "week"}`, g.rows);

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

  // Раздел про разбор задания единой таблицей — прежняя правая панель
  // (точное совпадение/донор-рекомендация/замена материала/карточка
  // "Выдано") без изменений в логике, просто вызывается теперь из
  // expandedRowRender одиночной (негрупповой) строки-нужды вместо
  // отдельной колонки сбоку — разворот строки эквивалентен прежнему
  // "выбрать строку" (см. selectRowForExpand).
  const renderSelectedRowPanel = () => (
    <>
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
                          // Аналог (см. "Аналоги ширин штрипса") считается совпадением
                          // раньше, чем сравнение ">" — иначе донор аналоговой, но
                          // числом большей ширины (290 вместо нужных 285) предлагался
                          // бы резать, хотя по факту это тот же штрипс, выдаём целиком.
                          isWidthMatch(widthAnalogGroups, u.width_mm, selectedStripWidth) ? (
                            <Button
                              size="small"
                              type="primary"
                              loading={directMutation.isPending}
                              onClick={() => confirmIfWrongWarehouse(u.warehouse_name, selected?.task.area, () => directMutation.mutate({ unitId: u.id }))}
                            >
                              Выдать целиком
                            </Button>
                          ) : u.width_mm > selectedStripWidth ? (
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
                                    isWidthMatch(widthAnalogGroups, u.width_mm, selectedStripWidth) ? (
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
                                    ) : u.width_mm > selectedStripWidth ? (
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
    </>
  );

  // Раздел про разбор задания единой таблицей — тап по строке эквивалентен
  // старому "выбрать строку". В прежнем (карточном) дизайне клик по ЛЮБОЙ
  // строке — хоть одиночной, хоть внутри группы — всегда выставлял
  // selected и поднимал общую панель (точное совпадение/донор/замена
  // материала/правка ширины через CuttingForm) рядом с групповым
  // баннером, они не были взаимоисключающими. Первая версия разворота
  // это потеряла — привязала общую панель только к негрупповым строкам,
  // из-за чего "замена материала" и правка ширины пропали для всех
  // реальных (обычно групповых) строк. Починено: selected выставляется
  // для ЛЮБОЙ ещё не выданной строки-нужды, группа она или нет — теперь
  // через кнопку "Подробнее" (модалка), не разворот строки.
  const openDetail = (row: NeedTableRow) => {
    setSelected({ task: row.task, line: row.line, assignment: row.assignment });
    setDetailRow(row);
  };
  const closeDetail = () => {
    setDetailRow(null);
    setSelected(null);
  };

  const renderDetailModalBody = (row: NeedTableRow): ReactNode => {
    const groupRows = groupRowsByRowKey.get(row.key) ?? [];
    if (groupRows.length > 1) {
      // Раздел про разбор задания единой таблицей — групповой план (донор
      // сразу на несколько строк) и общая панель по ЭТОЙ конкретной
      // строке (точное совпадение/донор/замена материала/своя ширина
      // через CuttingForm) показываются ВМЕСТЕ, не взаимоисключающе —
      // так же, как раньше банер и карточка строки сосуществовали.
      return (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <GroupDecisionPanel
            sku={findSku(skusQuery.data, row.line.material, row.line.color, row.line.thickness)}
            rows={groupRows}
            onOpenManualPicker={() => {
              const sku = findSku(skusQuery.data, row.line.material, row.line.color, row.line.thickness);
              if (sku) setManualPickerTarget({ sku, rows: groupRows });
            }}
          />
          {renderSelectedRowPanel()}
        </Space>
      );
    }
    return renderSelectedRowPanel();
  };

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
        <Select
          allowClear
          placeholder="Все статусы"
          style={{ width: 200, maxWidth: "100%" }}
          options={statusFilterOptions}
          value={statusFilter}
          onChange={setStatusFilter}
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
      </Space>

      {/* Раздел про разбор задания единой таблицей — "невидимые" репортёры
          статуса, один на группу материал+цвет+толщина+участок (включая
          группы из одной строки — backend сам применяет ABC-осторожность
          именно тогда). Смонтированы всегда, не только для развёрнутой
          строки, чтобы колонка "Статус" была верна для ВСЕХ строк сразу,
          без необходимости открывать каждую по очереди. */}
      {cuttingGroups.map((g) => (
        <GroupStatusReporter
          key={g.key}
          sku={findSku(skusQuery.data, g.material, g.color, g.thickness)}
          rows={g.rows}
          onAddToBatch={addToCuttingBatch}
          onAddStockDecision={addStockDecision}
          onReport={reportGroupInfos}
        />
      ))}

      <Table<TableRow>
        rowKey="key"
        dataSource={filteredTableRows}
        size="small"
        pagination={{ pageSize: 30 }}
        scroll={{ x: 1180 }}
        tableLayout="fixed"
        locale={{ emptyText: "Ничего не найдено по текущему фильтру" }}
        columns={[
          {
            title: (
              <Tooltip title="Когда актуально: 📅 распределено на сегодня · ⚠️ просрочено · ➖ ещё не распределено по дням · 🏭 весь участок, без деления по дням · ✋ выдано вручную">
                Когда
              </Tooltip>
            ),
            key: "badge",
            width: 56,
            render: (_, row) =>
              row.kind === "manual" ? (
                <Tooltip title="Выдано вручную — без привязки к заданию">
                  <Tag style={{ margin: 0 }}>✋</Tag>
                </Tooltip>
              ) : row.variant === "today" ? (
                row.overdue ? (
                  <Tooltip title={`Просрочено — было распределено на ${dayjs(row.assignment!.date).format("DD.MM")}`}>
                    <Tag color="error" style={{ margin: 0 }}>
                      ⚠️
                    </Tag>
                  </Tooltip>
                ) : (
                  <Tooltip title="Распределено на сегодня">
                    <Tag color="orange" style={{ margin: 0 }}>
                      📅
                    </Tag>
                  </Tooltip>
                )
              ) : areaRequiresDailyPlan(row.task.area) ? (
                <Tooltip title="Ещё не распределено по дням">
                  <Tag style={{ margin: 0 }}>➖</Tag>
                </Tooltip>
              ) : (
                <Tooltip title="Без деления по дням — весь участок">
                  <Tag color="blue" style={{ margin: 0 }}>
                    🏭
                  </Tag>
                </Tooltip>
              ),
          },
          {
            title: "Статус",
            key: "status",
            width: 108,
            render: (_, row) =>
              row.kind === "manual" ? (
                <Tag color="green">✅ вручную</Tag>
              ) : (
                renderStatusPill(
                  decidedLineIds.has(row.line.id) ? { kind: "decided" } : lineInfoMap.get(row.line.id)?.status,
                  issuedNoteForLine(row.line),
                )
              ),
          },
          {
            title: "Деталь",
            key: "part",
            width: 190,
            render: (_, row) => (row.kind === "manual" ? "—" : (row.line.part_name ?? "Деталь без названия")),
          },
          {
            title: "Задание / участок",
            key: "task",
            width: 170,
            render: (_, row) =>
              row.kind === "manual" ? (
                <>Без задания · {row.unit.area ? areaLabel(row.unit.area) : "—"}</>
              ) : (
                <>
                  {row.task.product_model_name ?? row.task.name ?? `Задание №${row.task.id}`} · {areaLabel(row.task.area)}
                  {row.assignment && (
                    <div style={{ fontSize: 11.5, color: "#8A8C99" }}>
                      {row.assignment.line_name} · {row.assignment.employee_names}
                    </div>
                  )}
                </>
              ),
          },
          {
            title: "Материал",
            key: "material",
            width: 160,
            render: (_, row) =>
              row.kind === "manual" ? skuLabel(row.unit.material_sku) : `${row.line.material}, ${row.line.color}, ${row.line.thickness} мм`,
          },
          {
            title: "Штрипс",
            key: "width",
            width: 72,
            render: (_, row) => (row.kind === "manual" ? row.unit.width_mm : row.line.strip_width_mm || row.line.width_mm),
          },
          {
            title: "Нужно",
            key: "need",
            width: 110,
            render: (_, row) =>
              row.kind === "manual" ? (
                `${row.unit.length_m} м`
              ) : row.assignment ? (
                <>
                  {row.assignment.quantity_pieces} шт ({neededLengthM(row).toFixed(2)} м)
                </>
              ) : (
                `${row.line.shortfall_length_m} м`
              ),
          },
          {
            title: "Действия",
            key: "actions",
            width: 150,
            render: (_, row) => {
              if (row.kind === "manual") {
                return (
                  <Space size={4} wrap>
                    <ActionIcon tip="Печать этикетки" onClick={() => printLabel(row.unit.id, { kind: "cutting_issue" })}>
                      🖨
                    </ActionIcon>
                    {canReturn && (
                      <AcceptReturnButton
                        unit={{
                          id: row.unit.id,
                          width_mm: row.unit.width_mm,
                          length_m: row.unit.length_m,
                          material_sku_id: row.unit.material_sku.id,
                          parent_id: row.unit.parent_id,
                          is_strip: row.unit.is_strip,
                          status: row.unit.status,
                        }}
                      />
                    )}
                  </Space>
                );
              }
              const issuedNote = issuedNoteForLine(row.line);
              if (issuedNote) {
                return (
                  <Space size={4} wrap>
                    {row.line.issued_units.length > 0 && (
                      <ActionIcon
                        tip={`Печать этикеток (${row.line.issued_units.length})`}
                        onClick={() =>
                          printLabelsBatch(
                            row.line.issued_units.map((u) => u.id),
                            { kind: "cutting_issue" },
                          )
                        }
                      >
                        🖨
                      </ActionIcon>
                    )}
                    {canReturn && row.line.issued_units.map((u) => <AcceptReturnButton key={u.id} unit={u} />)}
                    {/* Раздел про закрытие строки задания по выдаче — видна
                        именно здесь, где сейчас "🏭 на складе, ждёт довыдачи":
                        для строк, где всё уже физически улажено вне этого
                        экрана (issued_units пуст, но issued_length_m > 0
                        не даёт строке пропасть), это единственный способ
                        убрать её из списка. */}
                    {canManage && (
                      <Button size="small" loading={closeLineMutation.isPending} onClick={() => closeLineMutation.mutate({ taskId: row.task.id, lineId: row.line.id, isClosed: true })}>
                        Закрыть по выдаче
                      </Button>
                    )}
                  </Space>
                );
              }
              const info = lineInfoMap.get(row.line.id);
              const groupRows = groupRowsByRowKey.get(row.key);
              const sku = findSku(skusQuery.data, row.line.material, row.line.color, row.line.thickness);
              const decided = decidedLineIds.has(row.line.id);
              if (decided) {
                return (
                  <Tooltip title="Уже в решениях, ждёт выполнения">
                    <Typography.Text type="secondary" style={{ fontSize: 15 }}>
                      🕒
                    </Typography.Text>
                  </Tooltip>
                );
              }
              const stockMatch = info?.status.kind === "stock" ? info.status.match : null;
              return (
                <Space size={4} wrap>
                  {info?.acceptStock && (
                    <ActionIcon
                      tone="filled"
                      tip={stockMatch ? `Взять со склада — штрипс №${stockMatch.unit_id}` : "Взять со склада"}
                      onClick={info.acceptStock}
                    >
                      ✓
                    </ActionIcon>
                  )}
                  {info?.acceptCut && (
                    <ActionIcon
                      tone="outline"
                      tip={info.donorUnitId ? `В резку — донор №${info.donorUnitId}` : "Добавить в план резки"}
                      onClick={info.acceptCut}
                    >
                      ✂️
                    </ActionIcon>
                  )}
                  {groupRows && sku && (
                    <ActionIcon tip="Свой донор и раскрой" onClick={() => setManualPickerTarget({ sku, rows: groupRows })}>
                      🔧
                    </ActionIcon>
                  )}
                  <ActionIcon tip="Ещё — подробная карточка" onClick={() => openDetail(row)}>
                    ⋯
                  </ActionIcon>
                </Space>
              );
            },
          },
        ]}
      />

      {manualPickerTarget && (
        <ManualCuttingPlanModal
          open
          onClose={() => setManualPickerTarget(null)}
          sku={manualPickerTarget.sku}
          rows={manualPickerTarget.rows}
          onAddToBatch={addToCuttingBatch}
        />
      )}

      <Modal
        title={detailRow?.line.part_name ?? "Деталь"}
        open={!!detailRow}
        onCancel={closeDetail}
        footer={null}
        width={640}
        destroyOnHidden
      >
        {detailRow && renderDetailModalBody(detailRow)}
      </Modal>

      <Collapse
        ghost
        style={{ marginTop: 16 }}
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
