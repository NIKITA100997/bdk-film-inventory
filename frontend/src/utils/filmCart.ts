import { useSyncExternalStore } from "react";

/** Корзина заказа плёнки (22.10): из «Остатков» кладут метры, потом одной
 * заявкой отправляют закупщику. Живёт на этом устройстве, пока не отправлена. */
export interface CartLine {
  material: string;
  color: string;
  thickness: number;
  /** ширина рулона, мм; null — не знаем, выбрать в корзине */
  width_mm: number | null;
  length_m: number;
}

const KEY = "bdk:film.cart";
const listeners = new Set<() => void>();

function read(): CartLine[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CartLine[]) : [];
  } catch {
    return [];
  }
}

let lines: CartLine[] = read();

function write(next: CartLine[]) {
  lines = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* без хранилища — только в памяти */
  }
  listeners.forEach((l) => l());
}

export const filmKey = (l: { material: string; color: string; thickness: number }) => `${l.material}|${l.color}|${l.thickness}`;

export const filmCart = {
  /** та же плёнка той же ширины — метры складываются */
  add(line: CartLine) {
    const i = lines.findIndex((l) => filmKey(l) === filmKey(line) && l.width_mm === line.width_mm);
    if (i >= 0) write(lines.map((l, j) => (j === i ? { ...l, length_m: Math.round((l.length_m + line.length_m) * 100) / 100 } : l)));
    else write([...lines, line]);
  },
  update(index: number, patch: Partial<CartLine>) {
    write(lines.map((l, j) => (j === index ? { ...l, ...patch } : l)));
  },
  remove(index: number) {
    write(lines.filter((_, j) => j !== index));
  },
  clear() {
    write([]);
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useFilmCart(): CartLine[] {
  return useSyncExternalStore(subscribe, () => lines);
}

/** м² позиции: метры × ширина */
export const lineArea = (l: CartLine) => (l.width_mm ? Math.round(((l.length_m * l.width_mm) / 1000) * 100) / 100 : null);
