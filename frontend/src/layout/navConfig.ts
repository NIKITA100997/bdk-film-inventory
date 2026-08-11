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
  "prodazhnik",
];

// Единое функциональное дерево (8.2 раздел бэклога доработок) — раньше
// mobileBlocks/desktopSections дублировали друг друга по устройству, а не
// по функции ("Карточка единицы" была в меню три раза на один и тот же
// /m/unit-card). Видимость каждого пункта определяется ролью, а не тем,
// с телефона зашли или с компьютера — адаптив по экрану остаётся заботой
// AppLayout/Sider, не двух разных списков пунктов. "Карточка материала" и
// "Карточка единицы" (8.1) намеренно не пункты меню — вход в них только
// кликом по строке в "Остатках" или сканом QR.
export const navTree: NavBlock[] = [
  {
    key: "top",
    label: "",
    items: [
      { key: "overview", path: "/", label: "Обзор", roles: ALL_ROLES },
      { key: "stock", path: "/stock", label: "Остатки", roles: ALL_ROLES },
      { key: "receive", path: "/m/receive", label: "Приёмка", roles: ["operator_sklada"] },
      { key: "issue", path: "/m/issue", label: "Выдача участку", roles: ["operator_sklada"] },
      {
        key: "inventory-scan",
        path: "/m/inventory",
        label: "Инвентаризация — сканирование",
        roles: ["logist", "kladovshchik"],
      },
      {
        key: "inventory-sessions",
        path: "/inventory",
        label: "Инвентаризация — сессии",
        roles: ["logist", "kladovshchik"],
      },
    ],
  },
  {
    key: "orders-purchasing-reports",
    label: "",
    items: [
      // Заказ — единица планирования (4 раздел обратной связи, заменяет
      // собой недельный план): свои строки потребности + план/факт по
      // заказу, поэтому начальник цеха тоже сюда, а не в отдельный раздел.
      { key: "orders", path: "/orders", label: "Заказы", roles: ["logist", "kladovshchik", "nachalnik_tsekha"] },
      { key: "purchasing", path: "/purchasing", label: "Закупки", roles: ["snabzhenets"] },
      { key: "reports", path: "/reports", label: "Отчёты", roles: ["logist", "nachalnik_tsekha"] },
      // Калькулятор заказа для продажника (8 раздел обратной связи) —
      // считает потребность и сразу предлагает аналог из неликвида.
      { key: "sales-calculator", path: "/sales-calculator", label: "Калькулятор заказа", roles: ["prodazhnik"] },
    ],
  },
  {
    key: "admin",
    label: "Администрирование",
    items: [
      { key: "users", path: "/users", label: "Пользователи", roles: ["logist"] },
      { key: "dictionaries", path: "/dictionaries", label: "Справочники", roles: ["logist"] },
      { key: "settings", path: "/settings", label: "Настройки", roles: ["logist"] },
      { key: "label-template", path: "/label-template", label: "Макет этикетки", roles: ["logist"] },
    ],
  },
];

export const allNav = navTree.flatMap((block) => block.items);
