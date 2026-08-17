import { apiClient } from "./client";
import { suggestLocation } from "./storage";
import type { DeleteResult } from "./deletionRequests";
import { isMobileDevice, printPdfBlob, printHtmlDoc } from "../utils/printLabel";

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
  status: string;
  area: string | null;
  location_code: string | null;
  production_task_line_id: number | null;
  area_m2: number;
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
      width_mm: unit.width_mm,
      parent_id: null,
      warehouse_id: warehouseId,
    });
    placed.push(suggestion ? await placeUnit(unit.id, suggestion) : unit);
  }
  return placed;
}

export async function getUnit(unitId: number): Promise<MaterialUnit> {
  const { data } = await apiClient.get<MaterialUnit>(`/units/${unitId}`);
  return data;
}

export async function placeUnit(unitId: number, location_code: string): Promise<MaterialUnit> {
  const { data } = await apiClient.patch<MaterialUnit>(`/units/${unitId}/place`, { location_code });
  return data;
}

export interface SplitRequest {
  separate_width_mm: number;
  new_unit_location?: string;
}

export interface SplitResponse {
  parent: MaterialUnit;
  new_unit: MaterialUnit | null;
}

export async function splitUnit(unitId: number, payload: SplitRequest): Promise<SplitResponse> {
  const { data } = await apiClient.post<SplitResponse>(`/units/${unitId}/split`, payload);
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
}

export interface DonorSuggestion {
  unit_id: number;
  width_mm: number;
  length_m: number;
  width_class: string;
  recommended_cut_mm: number;
  waste_mm: number;
  days_in_storage?: number;
}

export interface IssueResult {
  outcome: "issued" | "donor_suggested" | "not_found";
  unit: MaterialUnit | null;
  donor: DonorSuggestion | null;
}

export async function issueUnit(payload: IssueRequest): Promise<IssueResult> {
  const { data } = await apiClient.post<IssueResult>("/units/issue", payload);
  return data;
}

// Раньше 3-значный union под жёсткий enum на бэкенде (раздел про
// администрирование участков) — участков теперь произвольное количество,
// код участка просто строка, живой список — src/api/areas.ts.
export type AreaValue = string;

// Раздел про учёт брака — причина списания единицы и, отдельно, причина
// брака в производстве (ProductionTaskLineReport) переиспользуют один и
// тот же набор значений на бэкенде (WriteOffReason), кроме "Отход при
// раскрое" — тот выставляется только системой при продольной резке, не
// предлагается ни в одной из форм на фронте. Значение и есть готовая
// подпись (в отличие от AreaValue) — отдельная labels-карта не нужна.
export type WriteOffReasonValue = "Брак поставщика" | "Повреждение на складе" | "Пересорт" | "Другое";

export const WRITE_OFF_REASON_OPTIONS: WriteOffReasonValue[] = [
  "Брак поставщика",
  "Повреждение на складе",
  "Пересорт",
  "Другое",
];

export async function issueUnitDirect(
  unitId: number,
  area: AreaValue,
  productionTaskLineId?: number,
): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/issue`, {
    area,
    production_task_line_id: productionTaskLineId,
  });
  return data;
}

export interface AtomicDonorIssueRequest {
  donor_unit_id: number;
  requested_width_mm: number;
  area: AreaValue;
  production_task_line_id?: number;
}

export interface AtomicDonorIssueResponse {
  issued_unit: MaterialUnit;
  remainder_unit: MaterialUnit | null;
}

export async function issueDonorAtomic(payload: AtomicDonorIssueRequest): Promise<AtomicDonorIssueResponse> {
  const { data } = await apiClient.post<AtomicDonorIssueResponse>("/units/issue-donor-atomic", payload);
  return data;
}

export interface CutRequest {
  cut_length_m: number;
  remainder_location?: string;
}

export async function cutUnit(unitId: number, payload: CutRequest): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/cut`, payload);
  return data;
}

export interface ReturnRequest {
  actual_length_m: number;
}

export async function returnUnit(unitId: number, payload: ReturnRequest): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/return`, payload);
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
  write_off_reason: WriteOffReasonValue | null;
  write_off_note: string | null;
}

export async function getUnitEvents(unitId: number): Promise<UnitEvent[]> {
  const { data } = await apiClient.get<UnitEvent[]>(`/units/${unitId}/events`);
  return data;
}

export async function writeOffUnit(unitId: number, reason: WriteOffReasonValue, note?: string): Promise<MaterialUnit> {
  const { data } = await apiClient.post<MaterialUnit>(`/units/${unitId}/write-off`, { reason, note });
  return data;
}

export async function deleteUnit(unitId: number): Promise<DeleteResult> {
  const { data } = await apiClient.delete<DeleteResult>(`/units/${unitId}`);
  return data;
}

export function printLabel(unitId: number): void {
  if (isMobileDevice()) {
    apiClient.get(`/labels/${unitId}/html`, { responseType: "text" }).then(({ data }) => {
      printHtmlDoc(data as string);
    });
  } else {
    apiClient.get(`/labels/${unitId}`, { responseType: "blob" }).then(({ data }) => {
      printPdfBlob(data as Blob);
    });
  }
}

// Очередь печати (раздел про ускорение работы) — один документ на
// несколько этикеток вместо printLabel в цикле: после приёмки партии из
// N рулонов одна вкладка с N страницами вместо N открытых вкладок печати.
export function printLabelsBatch(unitIds: number[]): void {
  if (unitIds.length === 0) return;
  if (isMobileDevice()) {
    apiClient.post("/labels/batch/html", { unit_ids: unitIds }, { responseType: "text" }).then(({ data }) => {
      printHtmlDoc(data as string);
    });
  } else {
    apiClient.post("/labels/batch", { unit_ids: unitIds }, { responseType: "blob" }).then(({ data }) => {
      printPdfBlob(data as Blob);
    });
  }
}
