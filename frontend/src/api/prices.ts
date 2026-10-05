import { apiClient } from "./client";

/** Цены (05.10): валюты с общим курсом, история цен позиции, загрузка из 1С. */
export interface Currency {
  code: string;
  name: string;
  symbol: string;
  /** Рублей за единицу; null — курс не задан. */
  rate: number | null;
  updated_at: string | null;
}

export interface ItemPrice {
  id: number;
  price: number;
  currency: string;
  unit: string;
  rub: number | null;
  source: "manual" | "1c" | "upd";
  source_name: string;
  doc: string | null;
  valid_from: string;
  note: string | null;
  user_id: number;
  created_at: string;
}

export interface ItemPrices {
  item_id: number;
  currency: string;
  unit: string;
  current: ItemPrice | null;
  history: ItemPrice[];
}

export interface PriceListRow {
  item_id: number;
  name: string;
  kind: string;
  code_1c: string | null;
  currency: string;
  unit: string;
  price: number | null;
  price_currency: string | null;
  price_unit: string | null;
  rub: number | null;
  source: string | null;
  valid_from: string | null;
}

export interface Import1CRow {
  line: number;
  code: string | null;
  name: string | null;
  price: number | null;
  currency: string | null;
  item_id: number | null;
  item_name: string | null;
  matched_by: string | null;
  old: string | null;
  errors: string[];
}

export const listCurrencies = async (): Promise<Currency[]> => (await apiClient.get<Currency[]>("/currencies")).data;
export const setCurrencyRate = async (code: string, rate: number | null): Promise<Currency> =>
  (await apiClient.put<Currency>(`/currencies/${code}`, { rate })).data;

export const getItemPrices = async (itemId: number): Promise<ItemPrices> =>
  (await apiClient.get<ItemPrices>(`/items/${itemId}/prices`)).data;
export const addItemPrice = async (
  itemId: number,
  p: { price: number; currency?: string; unit?: string; valid_from?: string; doc?: string; note?: string },
): Promise<ItemPrices> => (await apiClient.post<ItemPrices>(`/items/${itemId}/prices`, p)).data;
export const deleteItemPrice = async (priceId: number): Promise<void> => {
  await apiClient.delete(`/item-prices/${priceId}`);
};
export const setPriceSettings = async (itemId: number, s: { currency?: string; unit?: string }): Promise<ItemPrices> =>
  (await apiClient.put<ItemPrices>(`/items/${itemId}/price-settings`, s)).data;

export const listPrices = async (kind?: string): Promise<PriceListRow[]> =>
  (await apiClient.get<PriceListRow[]>("/prices", { params: { kind } })).data;

export const importPrices1C = async (p: {
  rows: { code?: string; name?: string; price?: unknown; currency?: string }[];
  default_currency?: string;
  valid_from?: string;
  doc?: string;
  dry_run: boolean;
}): Promise<Import1CRow[]> => (await apiClient.post<Import1CRow[]>("/prices/import-1c", p)).data;

export const fmtMoney = (v: number | null | undefined, currency = "RUB"): string => {
  if (v == null) return "—";
  const sym = { RUB: "₽", EUR: "€", USD: "$" }[currency] ?? currency;
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${sym}`;
};
