import type { Area } from "../auth/types";

export interface NavItem {
  key: string;
  path: string;
  label: string;
  // Не задан/пуст — виден любому аутентифицированному пользователю (раньше
  // это была роль-константа ALL_ROLES). Иначе видимость — по любому
  // совпадению права из списка (8.3 раздел бэклога доработок: роли теперь
  // создаются и назначаются в админке "Роли и права", а не хардкодятся
  // здесь — здесь остаётся только соответствие "пункт меню → какие права
  // его показывают", как и просил бэклог).
  permissions?: string[];
  // Если задано — экран виден только когда участок пользователя входит в
  // список (5.3 ТЗ: "Раскрой" есть в меню только у начальника цельнолистовых).
  areas?: Area[];
}

export interface NavBlock {
  key: string;
  label: string;
  items: NavItem[];
}

// Единое функциональное дерево (8.2 раздел бэклога доработок) — раньше
// mobileBlocks/desktopSections дублировали друг друга по устройству, а не
// по функции ("Карточка единицы" была в меню три раза на один и тот же
// /m/unit-card). Видимость каждого пункта определяется правами, а не тем,
// с телефона зашли или с компьютера — адаптив по экрану остаётся заботой
// AppLayout/Sider, не двух разных списков пунктов. "Карточка материала" и
// "Карточка единицы" (8.1) намеренно не пункты меню — вход в них только
// кликом по строке в "Остатках" или сканом QR.
export const navTree: NavBlock[] = [
  {
    key: "top",
    label: "",
    items: [
      { key: "overview", path: "/", label: "Обзор" },
      { key: "stock", path: "/stock", label: "Остатки" },
      { key: "receive", path: "/m/receive", label: "Приёмка", permissions: ["units.receive"] },
      { key: "issue", path: "/m/issue", label: "Выдача участку", permissions: ["units.issue"] },
      {
        key: "inventory-scan",
        path: "/m/inventory",
        label: "Инвентаризация — сканирование",
        permissions: ["inventory.manage"],
      },
      {
        key: "inventory-sessions",
        path: "/inventory",
        label: "Инвентаризация — сессии",
        permissions: ["inventory.manage"],
      },
    ],
  },
  {
    key: "orders-purchasing-reports",
    label: "",
    items: [
      // Заказ — единица планирования (4 раздел обратной связи, заменяет
      // собой недельный план): свои строки потребности + план/факт по
      // заказу, поэтому виден и тем, кто планирует (orders.plan), и тем,
      // кто создаёт/закрывает заказы (orders.manage/orders.close).
      { key: "orders", path: "/orders", label: "Заказы", permissions: ["orders.plan", "orders.manage", "orders.close"] },
      { key: "purchasing", path: "/purchasing", label: "Закупки", permissions: ["purchasing.manage"] },
      { key: "reports", path: "/reports", label: "Отчёты", permissions: ["reports.view"] },
      // Калькулятор заказа для продажника (8 раздел обратной связи) —
      // считает потребность и сразу предлагает аналог из неликвида.
      { key: "sales-calculator", path: "/sales-calculator", label: "Калькулятор заказа", permissions: ["sales_calculator.view"] },
    ],
  },
  {
    key: "admin",
    label: "Администрирование",
    items: [
      { key: "users", path: "/users", label: "Пользователи", permissions: ["users.manage"] },
      { key: "roles", path: "/roles", label: "Роли и права", permissions: ["users.manage"] },
      { key: "dictionaries", path: "/dictionaries", label: "Справочники", permissions: ["materials.manage"] },
      // Настройки объединяют стеллажи/зонирование (storage.manage) и
      // настройки расчётов (calc_settings.manage) на одном экране — виден
      // при наличии любого из двух, как и раньше давала одна роль logist.
      { key: "settings", path: "/settings", label: "Настройки", permissions: ["storage.manage", "calc_settings.manage"] },
      { key: "label-template", path: "/label-template", label: "Макет этикетки", permissions: ["labels.manage"] },
    ],
  },
];

export const allNav = navTree.flatMap((block) => block.items);
