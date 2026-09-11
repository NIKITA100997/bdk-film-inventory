import { message } from "antd";
import { isAxiosError } from "axios";
import { apiClient } from "./client";
import { suggestLocation } from "./storage";
import type { DeleteResult } from "./deletionRequests";
import { isMobileDevice, isVerticalPrint, printPdfBlob, printHtmlDoc } from "../utils/printLabel";

export interface MaterialSku {
  id: number;
  material: { id: number; name: string; is_active: boolean };
  color: { id: number; name: string; is_active: boolean };
  thickness: { id: number; value_mm: number; is_active: boolean };
  manufacturer: { id: number; name: string; is_active: boolean };
  supplier_code: string | null;
  native_width_mm: number | null;
  photo_path: string | null;
  is_active: boolean;
}

export interface MaterialUnit {
  id: number;
  parent_id: number | null;
  upd_number: string;
  pallet_number: string;
  material_sku: MaterialSku;
  width_mm: number;
  length_m: number;
  is_strip: boolean;
  status: string;
  area: string | null;
  location_code: string | null;
  production_task_line_id: number | null;
  legacy_task_note: string | null;
  area_m2: number;
  // Раздел про остатки по конкретному складу — не прямое поле в БД,
  // заполняется бэкендом только в /units/search/available.
  warehouse_name: string | null;
}

export function skuLabel(sku: MaterialSku): string {
  return `${sku.material.name}, ${sku.color.name}, ${sku.thickness.value_mm} мм, ${sku.manufacturer.name}`;
}

export interface ReceiveRequest {
  upd_number: string;
  pallet_number: string;
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  quantity: number;
  location_code?: string;
  is_strip?: boolean;
  occurred_at?: string;
}

export async function receiveUnits(payload: ReceiveRequest): Promise<MaterialUnit[]> {
  const { data } = await apiClient.post<MaterialUnit[]>("/units/receive", payload);
  return data;
}

/** Приёмка с автоподбором и автоматическим размещением по каждой созданной
 * единице (2.3/8.5 разделы бэклога доработок) — общая для сессии приёмки
 * (Receive.tsx) и одиночной регистрации единицы вне сессии (MaterialsExplorer.tsx).
 * warehouseId — раздел про мультисклад, необязателен (без него автоподбор
 * ищет по всем складам, как раньше). */
export async function receiveAndAutoPlace(
  payload: Omit<ReceiveRequest, "location_code">,
  warehouseId?: number,
): Promise<MaterialUnit[]> {
  const created = await receiveUnits(payload);
  const placed: MaterialUnit[] = [];
  for (const unit of created) {
    const suggestion = await suggestLocation({
      material_sku_id: unit.material_sku.id,
      is_strip: unit.is_strip,
      warehouse_id: warehouseId,
    });
    if (!suggestion) {
      placed.push(unit);
      continue;
    }
    try {
      // Раздел про аудит прав — единица уже реально создана (receiveUnits
      // выше отработал), авто-размещение здесь просто дополнительный шаг
      // поверх. Если оно падает по любой причине (нет units.place, стеллаж
      // занят и т.п.) — не роняем всю операцию с обманчивым "не удалось
      // зарегистрировать", а просто оставляем единицу без места, как и в
      // случае "правило зонирования не подобрало ничего" чуть выше.
      placed.push(await placeUnit(unit.id, suggestion, payload.occurred_at));
    } catch {
      placed.push(unit);
    }
  }
  return placed;
}

// Раздел про историю приёмок (проверка правильности внесения) — ширина/
// длина/ячейка здесь снимок события "Приход" на момент приёмки, а не
// живое состояние единицы: рулон могли успеть порезать позже, и его
// текущая ширина уже не совпадала бы с тем, что реально ввели.
export interface ReceiptUnit {
  unit_id: number;
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  location_code: string | null;
  current_status: string;
  current_width_mm: number;
}

export interface ReceiptSession {
  upd_number: string;
  pallet_number: string;
  received_at: string;
  received_by: string;
  warehouse_name: string | null;
  unit_count: number;
  total_area_m2: number;
  units: ReceiptUnit[];
}

export async function listReceipts(params?: {
  search?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}): Promise<ReceiptSession[]> {
  const { data } = await apiClient.get<ReceiptSession[]>("/units/receipts", { params });
  return data;
}

export async function getUnit(unitId: number): Promise<MaterialUnit> {
  const { data } = await apiClient.get<MaterialUnit>(`/units/${unitId}`);
  return data;
}

export async function placeUnit(unitId: number, location_code: string, occurred_at?: string): Promise<MaterialUnit> {
  const { data } = await apiClient.patch<MaterialUnit>(`/units/${unitId}/place`, { location_code, occurred_at });
  return data;
}

export interface ReassignSkuRequest {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
}

export async function reassignUnitSku(unitId: number, payload: ReassignSkuRequest): Promise<MaterialUnit> {
  const { data } = await apiClient.patch<MaterialUnit>(`/units/${unitId}/reassign-sku`, payload);
  return data;
}

export interface IssueRequest {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  area: AreaValue;
  production_task_line_id?: number;
  occurred_at?: string;
}

export interface DonorSuggestion {
  unit_id: number;
  width_mm: number;
  length_m: number;
  width_class: string;
  recommended_cut_mm: number;
  waste_mm: number;
  days_in_storage?: number;
  warehouse_name: string | null;
}

export interface IssueResult {
  outcome: "issued" | "donor_suggested" | "not_found";
  unit: MaterialUnit | null;
  donor: DonorSuggestion | null;
  // Раздел про выдачу мимо хаба — на своём складе площадки ничего не
  // нашлось, но остаток есть на другом складе.
  elsewhere_warehouse_name?: string | null;
}

export async function issueUnit(payload: IssueRequest): Promise<IssueResult> {
  const { data } = await apiClient.post<IssueResult>("/units/issue", payload);
  return data;
}

// Раньше 3-значный union под жёсткий enum на бэкенде (раздел про
// администрирование участков) — участков теперь произвольное количество,
// код участка просто строка, живой список — src/api/areas.ts.
export type AreaValue = string;

export async function issueUnitDirect(
  unitId: number,
  area: AreaValue,
  productionTaskLineId?: number,
  occurredAt?: string,
  // Раздел про замену плёнки на выдаче — donor (unit) может быть другой
  // номенклатурой/шириной, чем указано в строке задания; сервер примет
  // расхождение только при наличии права production_tasks.manage.
  overrideMaterial = false,
  overrideStripWidth = false,
): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/issue`, {
    area,
    production_task_line_id: productionTaskLineId,
    occurred_at: occurredAt,
    override_material: overrideMaterial,
    override_strip_width: overrideStripWidth,
  });
  return data;
}

export interface CuttingPlanRequest {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  needed_widths_mm: number[];
  // По индексу с needed_widths_mm (раздел про разбор задания единой
  // таблицей) — нужна, чтобы бэкенд отличил точное совпадение остатка на
  // складе (хватает и по ширине, и по длине) от настоящей нехватки,
  // требующей резки, и не включал уже закрытые потребности в подбор
  // донора (см. stock_matches в CuttingPlan ниже).
  needed_lengths_m: number[];
  // Раздел про площадки — участок группы (все строки группы всегда с
  // одного участка), чтобы точное совпадение и подбор донора искали в
  // первую очередь на его домашнем складе, как и /units/issue.
  area?: AreaValue;
}

export interface CuttingPlanDonor {
  unit_id: number;
  width_mm: number;
  length_m: number;
  days_in_storage: number;
}

export interface CuttingPlanStockMatch {
  index: number; // позиция в исходном needed_widths_mm/needed_lengths_m
  unit_id: number;
  width_mm: number;
  length_m: number;
  location_code: string | null;
}

export interface CuttingPlan {
  donor: CuttingPlanDonor | null;
  covered_widths_mm: number[];
  uncovered_widths_mm: number[];
  waste_mm: number;
  covered_indices: number[];
  stock_matches: CuttingPlanStockMatch[];
}

// План резки одного донора сразу на несколько разных ширин штрипса одной
// плёнки (раздел про несколько разных потребностей за день) — щелевая
// резка режет рулон на несколько полос за проход, поэтому выгоднее
// резать один донор сразу под несколько нужных ширин, чем по одной.
export async function getCuttingPlan(payload: CuttingPlanRequest): Promise<CuttingPlan> {
  const { data } = await apiClient.post<CuttingPlan>("/units/cutting-plan", payload);
  return data;
}

export interface CutRequest {
  cut_length_m: number;
  remainder_location?: string;
  occurred_at?: string;
}

// Раскрой пачкой (MaterialsExplorer.tsx) — независимый инструмент, режет
// список РАЗНЫХ единиц по длине без сохранения куска, не относится к
// единой резке одного донора ниже.
export async function cutUnit(unitId: number, payload: CutRequest): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/cut`, payload);
  return data;
}

// Единая резка донора (раздел про объединение резки в одну форму,
// CuttingForm.tsx) — заменяет прежние /split, /split-length,
// /issue-donor-atomic, /cutting-plan/execute одним атомарным запросом:
// опциональный отрез по длине на всю ширину донора, затем ноль и более
// кусков по ширине из остатка, каждый со своим назначением.
export interface CuttingDestination {
  kind: "keep" | "issue" | "discard" | "transfer";
  location_code?: string;
  area?: AreaValue;
  production_task_line_id?: number;
  to_warehouse_id?: number;
}

export interface CuttingWidthSpec {
  width_mm: number;
  destination: CuttingDestination;
  actual_length_m?: number;
  override_strip_width?: boolean;
  override_material?: boolean;
}

export interface CuttingRecipeRequest {
  donor_unit_id: number;
  length_precut_m?: number;
  length_destination?: CuttingDestination;
  width_cuts?: CuttingWidthSpec[];
  occurred_at?: string;
}

export interface CuttingRecipeResultPiece {
  unit: MaterialUnit;
  discrepancy_flagged: boolean;
}

export interface CuttingRecipeResponse {
  length_result: CuttingRecipeResultPiece | null;
  width_results: CuttingRecipeResultPiece[];
  donor_remainder: MaterialUnit;
}

export async function executeCuttingRecipe(payload: CuttingRecipeRequest): Promise<CuttingRecipeResponse> {
  const { data } = await apiClient.post<CuttingRecipeResponse>("/units/cutting-recipe", payload);
  return data;
}

// Журнал резок (раздел про отмену резки и историю в «Заготовках») —
// CuttingHistory.tsx на вкладке «История резки».
export interface CuttingOperationPiece {
  id: number;
  width_mm: number;
  length_m: number;
  status: string;
  area: string | null;
  location_code: string | null;
  destination_kind: "keep" | "issue" | "transfer";
}

export interface CuttingOperation {
  id: number;
  donor_unit_id: number;
  donor_material_sku: MaterialSku;
  donor_width_before_mm: number;
  donor_length_before_m: number;
  donor_status_before: string;
  donor_width_after_mm: number;
  donor_length_after_m: number;
  donor_status_after: string;
  donor_auto_written_off: boolean;
  length_precut_m: number | null;
  occurred_at: string;
  created_at: string;
  user_id: number;
  user_name: string;
  undone_at: string | null;
  undone_by: number | null;
  undone_by_name: string | null;
  resulting_pieces: CuttingOperationPiece[];
  can_undo: boolean;
  cannot_undo_reason: string | null;
}

export interface CuttingOperationsParams {
  date_from?: string;
  date_to?: string;
  donor_unit_id?: number;
  material_sku_id?: number;
  include_undone?: boolean;
  limit?: number;
  offset?: number;
}

export async function getCuttingOperations(params: CuttingOperationsParams): Promise<CuttingOperation[]> {
  const { data } = await apiClient.get<CuttingOperation[]>("/units/cutting-operations", { params });
  return data;
}

export async function undoCuttingOperation(operationId: number): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/cutting-operations/${operationId}/undo`);
  return data;
}

export interface ReturnRequest {
  actual_length_m: number;
  occurred_at?: string;
  // Раздел про сверку рулонов на окутке — "вернуть и сразу списать
  // остаток" одним действием вместо двух походов в карточку единицы.
  write_off_reason?: string;
  write_off_note?: string;
}

export async function returnUnit(unitId: number, payload: ReturnRequest): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/return`, payload);
  return data;
}

// Раздел про ревизию путей плёнки/п/ф — формальная корректировка
// length_m вместо правки истории напрямую в БД: поднадзорное действие,
// всегда добавляет событие (Корректировка), причина обязательна.
export interface UnitAdjustRequest {
  actual_length_m: number;
  reason: string;
  note?: string;
  occurred_at?: string;
}

export async function adjustUnit(unitId: number, payload: UnitAdjustRequest): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/adjust`, payload);
  return data;
}

export interface ReturnPreview {
  expected_return_length_m: number | null;
  good_pieces: number;
  defect_pieces: number;
}

export async function getReturnPreview(unitId: number): Promise<ReturnPreview> {
  const { data } = await apiClient.get<ReturnPreview>(`/units/${unitId}/return-preview`);
  return data;
}

export type UnitStatusValue = "Принят" | "На_хранении" | "Выдан_участку" | "Списан";

export interface SearchParams {
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
  width_mm?: number;
  min_length_m?: number;
  status?: UnitStatusValue;
  area?: AreaValue;
  unplaced?: boolean;
  warehouse_id?: number;
}

export async function searchUnits(params: SearchParams): Promise<MaterialUnit[]> {
  const { data } = await apiClient.get<MaterialUnit[]>("/units/search/available", { params });
  return data;
}

export interface UnitEvent {
  event_id: number;
  event_type: string;
  timestamp: string;
  user_id: number;
  from_length: number | null;
  to_length: number | null;
  from_cell: string | null;
  to_cell: string | null;
  quantity_delta_m: number;
  write_off_reason: string | null;
  write_off_note: string | null;
}

export async function getUnitEvents(unitId: number): Promise<UnitEvent[]> {
  const { data } = await apiClient.get<UnitEvent[]>(`/units/${unitId}/events`);
  return data;
}

export async function writeOffUnit(
  unitId: number,
  reason: string,
  note?: string,
  occurredAt?: string,
): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/write-off`, {
    reason,
    note,
    occurred_at: occurredAt,
  });
  return data;
}

export async function deleteUnit(unitId: number): Promise<DeleteResult> {
  const { data } = await apiClient.delete<DeleteResult>(`/units/${unitId}`);
  return data;
}

export interface PrintLabelOptions {
  // Явный вид макета — по умолчанию бэкенд сам определяет рулон/штрипс по
  // MaterialUnit.is_strip; передаётся только там, где нужен другой вид, не
  // связанный напрямую с типом единицы — например "cutting_issue" сразу
  // после резки/выдачи участку (раздел про макет для этапа резки/выдачи).
  kind?: "roll" | "strip" | "cutting_issue";
}

// Раздел про "не открывается окно печати" на планшете — раньше ошибка
// запроса (сеть, просроченный токен, 4xx/5xx) просто терялась в
// необработанном отклонении промиса: ни диалога печати, ни какой-либо
// заметной реакции на экране, оператор видел ровно ничего. Теперь любая
// ошибка хотя бы показывает message.error — вместо тишины.
function printErrorMessage(e: unknown): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  if (isAxiosError(e) && !e.response) return "Нет связи с сервером — проверьте подключение";
  return "Не удалось подготовить этикетку для печати";
}

// Раздел про диагностику "не открывается окно печати" — три статуса на
// одном ключе (antd подменяет сообщение в том же месте, не копит их):
// "Готовим..." сразу же подтверждает, что нажатие вообще дошло до кода;
// "Отправлено на печать" после — что запрос и вызов печати отработали
// без ошибок (если после этого физически ничего не появилось — значит
// проблема в самой печати/ОС планшета, а не в приложении); message.error
// — если запрос или сама печать бросили исключение.
const PRINT_MESSAGE_KEY = "print-label";

export function printLabel(unitId: number, options?: PrintLabelOptions): void {
  message.loading({ content: "Готовим этикетку к печати…", key: PRINT_MESSAGE_KEY, duration: 0 });
  const params = { vertical: isVerticalPrint(), kind: options?.kind };
  const request = isMobileDevice()
    ? apiClient.get(`/labels/${unitId}/html`, { params, responseType: "text" }).then(({ data }) => printHtmlDoc(data as string))
    : apiClient.get(`/labels/${unitId}`, { params, responseType: "blob" }).then(({ data }) => printPdfBlob(data as Blob));
  request
    .then(() => message.success({ content: "Отправлено на печать", key: PRINT_MESSAGE_KEY }))
    .catch((e) => message.error({ content: printErrorMessage(e), key: PRINT_MESSAGE_KEY }));
}

// --- Сверка рулонов на окутке ---------------------------------------------

export interface ReconciliationRow {
  unit_id: number;
  width_mm: number;
  length_m: number;
  status: UnitStatusValue;
  area: string | null;
  location_code: string | null;
  legacy_task_note: string | null;
  task_line_id: number | null;
  task_area: string | null;
  task_label: string | null;
  task_quantity_pieces: number | null;
  task_length_m: number | null;
  reports_count: number;
  good_pieces_sum: number;
  defect_pieces_sum: number;
}

export async function getReconciliation(area?: string, onlyAttention?: boolean): Promise<ReconciliationRow[]> {
  const { data } = await apiClient.get<ReconciliationRow[]>("/units/reconciliation", {
    params: { area, only_attention: onlyAttention },
  });
  return data;
}

export async function linkTaskLine(
  unitId: number,
  productionTaskLineId: number,
  options?: { overrideStripWidth?: boolean; overrideMaterial?: boolean },
): Promise<MaterialUnit> {
  const { data } = await apiClient.patch<MaterialUnit>(`/units/${unitId}/task-line`, {
    production_task_line_id: productionTaskLineId,
    override_strip_width: options?.overrideStripWidth ?? false,
    override_material: options?.overrideMaterial ?? false,
  });
  return data;
}

export async function setLegacyTaskNote(unitId: number, note: string | null): Promise<MaterialUnit> {
  const { data } = await apiClient.patch<MaterialUnit>(`/units/${unitId}/legacy-task-note`, { note });
  return data;
}

// Очередь печати (раздел про ускорение работы) — один документ на
// несколько этикеток вместо printLabel в цикле: после приёмки партии из
// N рулонов одна вкладка с N страницами вместо N открытых вкладок печати.
export function printLabelsBatch(unitIds: number[], options?: PrintLabelOptions): void {
  if (unitIds.length === 0) return;
  message.loading({ content: "Готовим этикетки к печати…", key: PRINT_MESSAGE_KEY, duration: 0 });
  const params = { vertical: isVerticalPrint(), kind: options?.kind };
  const request = isMobileDevice()
    ? apiClient
        .post("/labels/batch/html", { unit_ids: unitIds }, { params, responseType: "text" })
        .then(({ data }) => printHtmlDoc(data as string))
    : apiClient
        .post("/labels/batch", { unit_ids: unitIds }, { params, responseType: "blob" })
        .then(({ data }) => printPdfBlob(data as Blob));
  request
    .then(() => message.success({ content: "Отправлено на печать", key: PRINT_MESSAGE_KEY }))
    .catch((e) => message.error({ content: printErrorMessage(e), key: PRINT_MESSAGE_KEY }));
}
