import type { Area, UserRole } from "../auth/types";

export interface NavItem {
  key: string;
  path: string;
  label: string;
  roles: UserRole[];
  // Если задано — экран виден только когда участок пользователя входит в
  // список (5.3 ТЗ: "Раскрой" есть в меню только у начальника цельнолистовых).
  areas?: Area[];
}

export interface NavBlock {
  key: string;
  label: string;
  items: NavItem[];
}

const ALL_ROLES: UserRole[] = [
  "operator_sklada",
  "kladovshchik",
  "nachalnik_uchastka",
  "nachalnik_tsekha",
  "logist",
  "snabzhenets",
];

// 5.3/5.5 ТЗ — мобильное меню это не плоский список, а три блока, видимость
// каждого зависит от роли.
export const mobileBlocks: NavBlock[] = [
  {
    key: "warehouse",
    label: "Склад",
    items: [
      { key: "m-receive", path: "/m/receive", label: "Приёмка", roles: ["operator_sklada"] },
      { key: "m-split", path: "/m/split", label: "Разделить рулон", roles: ["operator_sklada"] },
      { key: "m-issue", path: "/m/issue", label: "Выдача участку", roles: ["operator_sklada"] },
      { key: "m-place", path: "/m/place", label: "Размещение в ячейку", roles: ["kladovshchik", "operator_sklada"] },
      { key: "m-transfer", path: "/m/return", label: "Перенести на склад", roles: ["kladovshchik", "operator_sklada"] },
      { key: "m-inventory", path: "/m/inventory", label: "Инвентаризация", roles: ["logist", "kladovshchik"] },
    ],
  },
  {
    key: "my-area",
    label: "Мой участок",
    items: [
      { key: "m-my-area", path: "/m/my-area", label: "Что у меня сейчас", roles: ["nachalnik_uchastka"] },
      {
        key: "m-cut",
        path: "/m/cut",
        label: "Раскрой",
        roles: ["nachalnik_uchastka"],
        areas: ["tselnolistovye_dveri"],
      },
      { key: "m-return", path: "/m/return", label: "Возврат", roles: ["nachalnik_uchastka"] },
    ],
  },
  {
    key: "common",
    label: "Общее",
    items: [
      { key: "m-search", path: "/m/search", label: "Поиск остатка", roles: ALL_ROLES },
      { key: "m-material-card", path: "/materials", label: "Карточка материала", roles: ALL_ROLES },
    ],
  },
];

// 5.4/5.5 ТЗ — десктопное боковое меню из семи разделов.
export const desktopSections: NavBlock[] = [
  {
    key: "overview",
    label: "Обзор",
    items: [{ key: "d-overview", path: "/", label: "Обзор", roles: ALL_ROLES }],
  },
  {
    key: "materials",
    label: "Материалы",
    items: [
      { key: "d-materials", path: "/materials", label: "Карточка материала", roles: ["logist", "nachalnik_tsekha", "snabzhenets"] },
      { key: "d-dashboard", path: "/dashboard", label: "Дашборд остатков", roles: ["logist", "nachalnik_tsekha", "snabzhenets"] },
      {
        key: "d-recommendations",
        path: "/recommendations",
        label: "Рекомендации по резке",
        roles: ["logist", "kladovshchik", "operator_sklada"],
      },
      { key: "d-inventory", path: "/inventory", label: "Инвентаризация", roles: ["logist", "kladovshchik"] },
    ],
  },
  {
    key: "planning",
    label: "Планирование",
    items: [
      { key: "d-plan", path: "/plan", label: "Недельный план", roles: ["nachalnik_tsekha"] },
      { key: "d-plan-fact", path: "/plan-fact", label: "План/факт", roles: ["nachalnik_tsekha", "logist"] },
    ],
  },
  {
    key: "orders",
    label: "Заказы",
    items: [{ key: "d-orders", path: "/orders", label: "Заказы", roles: ["logist", "kladovshchik"] }],
  },
  {
    key: "purchasing",
    label: "Закупки",
    items: [{ key: "d-purchasing", path: "/purchasing", label: "Закупки", roles: ["snabzhenets"] }],
  },
  {
    key: "reports",
    label: "Отчёты",
    items: [{ key: "d-reports", path: "/reports", label: "Отчёты", roles: ["logist", "nachalnik_tsekha"] }],
  },
  {
    key: "admin",
    label: "Администрирование",
    items: [
      { key: "d-settings", path: "/settings", label: "Настройки", roles: ["admin", "kladovshchik"] },
      { key: "d-dictionaries", path: "/dictionaries", label: "Справочники", roles: ["admin", "kladovshchik"] },
    ],
  },
];

export const allBlocks = [...mobileBlocks, ...desktopSections];
export const allNav = allBlocks.flatMap((block) => block.items);
