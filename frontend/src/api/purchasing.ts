import { apiClient } from "./client";
import type { DeleteResult } from "./deletionRequests";

export interface PurchaseRequest {
  id: number;
  material: string;
  color: string;
  thickness: number;
  requested_area_m2: number;
  current_stock_m2: number;
  note: string | null;
  status: string;
  origin: string;
  linked_upd_number: string | null;
  created_by: number;
  created_at: string;
  closed_at: string | null;
  supplier: string | null;
  price_per_m2: number | null;
  order_id: number | null;
}

export interface SupplierOrderLine {
  material: string;
  color: string;
  thickness: number;
  requested_area_m2: number;
  current_stock_m2: number;
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
  open_requested_area_m2: number;
  usual_supplier: string | null;
}

export interface PurchaseRequestCreate {
  material: string;
  color: string;
  thickness: number;
  requested_area_m2: number;
  note?: string;
  supplier?: string;
  price_per_m2?: number;
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
