/** Признаки позиции номенклатуры (backend: services/item_attrs.py). */
export const DIRECTIONS: Record<string, string> = {
  shield: "Щитовые",
  tsarg: "Царговые",
  panel: "Панели (мет. двери)",
  trim: "Погонаж",
};
export const STAGES: Record<string, string> = {
  blank: "Заготовка",
  bare: "Деталь без плёнки",
  laminated: "Деталь в плёнке",
  stripped: "После снятия плёнки",
};
export const MODES: Record<string, string> = { order: "Под заказ", stock: "На склад" };

export const STAGE_COLOR: Record<string, string> = { blank: "default", bare: "orange", laminated: "blue", stripped: "magenta" };

export const toOptions = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));
