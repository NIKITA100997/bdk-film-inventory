import { apiClient } from "./client";

// Склад готовой продукции и отгрузка по счёту (06.10).

export interface FgStockRow {
  item_id: number;
  item_name: string;
  site_id: number | null;
  site_name: string | null;
  order_line_id: number | null;
  order_id: number | null;
  order_name: string | null;
  invoice_no: string | null;
  qty: number;
}

export interface FgMoveRow {
  id: number;
  occurred_at: string;
  kind: "receipt" | "shipment" | "unship" | "adjust" | "transfer" | "return";
  item_id: number;
  item_name: string;
  qty: number;
  site_name: string | null;
  invoice_no: string | null;
  order_id: number | null;
  shipment_id: number | null;
  note: string | null;
  user_name: string | null;
}

export interface FgInvoiceLine {
  order_line_id: number;
  order_id: number;
  order_name: string;
  item_id: number;
  item_name: string;
  ordered: number;
  received: number;
  shipped: number;
  on_stock: number;
  by_site: Record<string, number>;
}

export interface FgInvoice {
  invoice_no: string;
  orders: string[];
  ordered: number;
  received: number;
  shipped: number;
  on_stock: number;
  lines: FgInvoiceLine[];
}

export interface FgShipment {
  id: number;
  invoice_no: string | null;
  customer: string | null;
  note: string | null;
  status: "shipped" | "cancelled";
  created_at: string;
  created_by_name: string | null;
  cancelled_at: string | null;
  lines: { order_line_id: number | null; item_name: string; qty: number; order_name: string | null; site_name: string | null; returned: number }[];
  total: number;
  returned: number;
}

export const FG_KIND_LABEL: Record<FgMoveRow["kind"], string> = {
  receipt: "Упаковано",
  shipment: "Отгружено",
  unship: "Отгрузка отменена",
  adjust: "Корректировка",
  transfer: "Перемещение",
  return: "Возврат от клиента",
};

export const listFgStock = async (): Promise<FgStockRow[]> => (await apiClient.get<FgStockRow[]>("/finished-goods/stock")).data;
export const listFgMoves = async (): Promise<FgMoveRow[]> => (await apiClient.get<FgMoveRow[]>("/finished-goods/moves")).data;
export const listFgInvoices = async (): Promise<FgInvoice[]> => (await apiClient.get<FgInvoice[]>("/finished-goods/invoices")).data;
export const listFgShipments = async (): Promise<FgShipment[]> => (await apiClient.get<FgShipment[]>("/finished-goods/shipments")).data;

export const shipFg = async (payload: {
  invoice_no: string;
  customer?: string | null;
  note?: string | null;
  lines: { order_line_id: number; site_id: number | null; qty: number }[];
}): Promise<FgShipment> => (await apiClient.post<FgShipment>("/finished-goods/shipments", payload)).data;

export const cancelFgShipment = async (id: number): Promise<FgShipment> =>
  (await apiClient.post<FgShipment>(`/finished-goods/shipments/${id}/cancel`)).data;

export const returnFromCustomer = async (
  shipmentId: number,
  payload: { site_id: number | null; reason: string; lines: { order_line_id: number; qty: number }[] },
): Promise<FgShipment> => (await apiClient.post<FgShipment>(`/finished-goods/shipments/${shipmentId}/return`, payload)).data;

export const transferFg = async (payload: {
  item_id: number;
  order_line_id: number | null;
  from_site_id: number | null;
  to_site_id: number;
  qty: number;
  note?: string | null;
}): Promise<FgStockRow[]> => (await apiClient.post<FgStockRow[]>("/finished-goods/transfer", payload)).data;

export const adjustFg = async (payload: {
  item_id: number;
  site_id: number | null;
  order_line_id: number | null;
  actual_qty: number;
  reason: string;
}): Promise<FgStockRow[]> => (await apiClient.post<FgStockRow[]>("/finished-goods/adjust", payload)).data;
