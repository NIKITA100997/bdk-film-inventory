import { apiClient } from "./client";
import { opHeaders } from "../utils/opKey";
import type { DeleteResult } from "./deletionRequests";

/** Заявка на закупку: плёнка (material/color/thickness, м²) или любая другая
 * позиция — материал, комплектующее (item_*, в её единице; 14.10). */
export interface PurchaseRequest {
  id: number;
  material: string | null;
  color: string | null;
  thickness: number | null;
  requested_area_m2: number | null;
  current_stock_m2: number | null;
  item_id?: number | null;
  item_name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  current_stock?: number | null;
  price_per_unit?: number | null;
  note: string | null;
  status: string;
  origin: string;
  linked_upd_number: string | null;
  created_by: number;
  created_at: string;
  closed_at: string | null;
  supplier: string | null;
  price_per_m2: number | null;
  promised_delivery_date: string | null;
  need_by?: string | null;
  order_id: number | null;
}

export interface SupplierOrderLine {
  material: string | null;
  color: string | null;
  thickness: number | null;
  requested_area_m2: number | null;
  current_stock_m2: number | null;
  item_name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  request_ids: number[];
}

export interface SupplierOrder {
  id: number;
  supplier: string;
  note: string | null;
  created_by: number;
  created_at: string;
  is_open: boolean;
  lines: SupplierOrderLine[];
}

export interface SupplierOrderCreate {
  supplier: string;
  request_ids: number[];
  note?: string;
}

export interface StockOverviewLine {
  material: string;
  color: string;
  thickness: number;
  total_area_m2: number;
  reserved_area_m2: number;
  /** Из резерва — под ламинацию панелей заказанных дверей. */
  panel_demand_m2?: number;
  open_requested_area_m2: number;
  usual_supplier: string | null;
  days_of_stock_remaining: number | null;
  reorder_suggested: boolean;
  /** нормативы группы (08.10), м² */
  min_stock_m2?: number | null;
  min_batch_m2?: number | null;
  batch_multiple_m2?: number | null;
  shortage_m2?: number;
  to_order_m2?: number;
}

export interface PurchaseRequestCreate {
  material: string;
  color: string;
  thickness: number;
  requested_area_m2: number;
  note?: string;
  supplier?: string;
  price_per_m2?: number;
  promised_delivery_date?: string;
}

export interface PurchaseRequestShopFloorCreate {
  material: string;
  color: string;
  thickness: number;
  requested_area_m2: number;
  note?: string;
}

export interface PurchaseRequestUpdate {
  supplier?: string;
  price_per_m2?: number;
  promised_delivery_date?: string;
}

/** Название позиции заявки/строки заказа — плёнка или материал. */
export const purchaseLabel = (r: { material: string | null; color: string | null; thickness: number | null; item_name?: string | null }) =>
  r.item_name ?? `${r.material}, ${r.color}, ${r.thickness} мм`;
/** Количество с единицей — «120 м²» у плёнки, «12 листов» у материала. */
export const purchaseQty = (r: { requested_area_m2: number | null; quantity?: number | null; unit?: string | null; item_name?: string | null }) =>
  r.item_name ? `${r.quantity ?? 0} ${r.unit ?? ""}`.trim() : `${r.requested_area_m2 ?? 0} м²`;

export async function createItemPurchaseRequest(payload: {
  item_id: number;
  quantity: number;
  need_by?: string | null;
  note?: string;
  supplier?: string;
  price_per_unit?: number;
}, opKey?: string): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>("/purchase-requests/items", payload, opHeaders(opKey));
  return data;
}

/** Поставка по заявке на материал: приход на склад + закрытие заявки. */
export async function receiveItemPurchaseRequest(
  id: number,
  payload: { quantity: number; doc?: string; price?: number; close: boolean; occurred_at?: string | null },
  opKey?: string,
): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>(`/purchase-requests/${id}/receive-item`, payload, opHeaders(opKey));
  return data;
}

export async function listPurchaseRequests(statusFilter?: string): Promise<PurchaseRequest[]> {
  const { data } = await apiClient.get<PurchaseRequest[]>("/purchase-requests", {
    params: statusFilter ? { status_filter: statusFilter } : undefined,
  });
  return data;
}

export async function createPurchaseRequest(payload: PurchaseRequestCreate): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>("/purchase-requests", payload);
  return data;
}

// Заявка "с цеха" — кнопка "Подать заявку на закупку" на "Выдаче участку"
// при нехватке остатка под строку задания.
export async function createShopFloorPurchaseRequest(payload: PurchaseRequestShopFloorCreate): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>("/purchase-requests/shop-floor", payload);
  return data;
}

export async function updatePurchaseRequest(id: number, payload: PurchaseRequestUpdate): Promise<PurchaseRequest> {
  const { data } = await apiClient.patch<PurchaseRequest>(`/purchase-requests/${id}`, payload);
  return data;
}

export async function closePurchaseRequest(id: number): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>(`/purchase-requests/${id}/close`);
  return data;
}

export async function deletePurchaseRequest(id: number): Promise<DeleteResult> {
  const { data } = await apiClient.delete<DeleteResult>(`/purchase-requests/${id}`);
  return data;
}

export async function deleteSupplierOrder(id: number): Promise<DeleteResult> {
  const { data } = await apiClient.delete<DeleteResult>(`/supplier-orders/${id}`);
  return data;
}

// Привязка заявки к конкретной приёмке по УПД (раздел про ускорение
// приёмки) — закрывает заявку и запоминает, каким УПД она была закрыта.
export async function fulfillPurchaseRequest(id: number, updNumber: string): Promise<PurchaseRequest> {
  const { data } = await apiClient.post<PurchaseRequest>(`/purchase-requests/${id}/fulfill`, { upd_number: updNumber });
  return data;
}

// «Остатки и резерв» (раздел про экран снабженца) — остаток на складе,
// сколько уже нужно текущим заданиям цеха и сколько уже в открытых
// заявках, чтобы не заказать повторно.
export async function getStockOverview(): Promise<StockOverviewLine[]> {
  const { data } = await apiClient.get<StockOverviewLine[]>("/purchase-requests/stock-overview");
  return data;
}

export interface StockForSkuOut {
  sku_id: number;
  material: string;
  color: string;
  thickness: number;
  total_area_m2: number;
  reserved_area_m2: number;
  available_area_m2: number;
}

// Раздел про калькулятор заказа продажника — остаток/резерв по нескольким
// позициям сразу (заказ из нескольких цветов), без прав purchasing.manage.
export async function getStockForSkus(skuIds: number[]): Promise<StockForSkuOut[]> {
  if (skuIds.length === 0) return [];
  const { data } = await apiClient.post<StockForSkuOut[]>("/purchase-requests/stock-for-skus", {
    sku_ids: skuIds,
  });
  return data;
}

export async function listSupplierOrders(): Promise<SupplierOrder[]> {
  const { data } = await apiClient.get<SupplierOrder[]>("/supplier-orders");
  return data;
}

// Объединение нескольких заявок в один заказ поставщику — заявки
// остаются отдельными записями, только получают общий order_id.
export async function createSupplierOrder(payload: SupplierOrderCreate): Promise<SupplierOrder> {
  const { data } = await apiClient.post<SupplierOrder>("/supplier-orders", payload);
  return data;
}

/** Плёнка под ламинацию панелей заказанных дверей (по панели). */
export interface PanelFilmRow {
  part_id: number;
  part_name: string;
  need_pieces: number;
  laminated: number;
  to_laminate: number;
  film_width_mm: number;
  film_width_from_part: boolean;
  /** Откуда ширина плёнки (штрипс детали / +7 мм на Фабрике / ширина панели). */
  width_rule: string;
  length_m: number;
  area_m2: number;
  /** Закреплённая плёнка; null — не выбрана (в резерв не идёт). */
  film: string | null;
}

export async function getPanelFilm(): Promise<PanelFilmRow[]> {
  const { data } = await apiClient.get<PanelFilmRow[]>("/purchase-requests/panel-film");
  return data;
}
