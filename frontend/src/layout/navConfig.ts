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
    key: "main",
    label: "Основное",
    items: [
      { key: "overview", path: "/", label: "Обзор" },
      // Сквозная справка "что у нас есть" для всех ролей (продажник,
      // производство, склад) — не складская операция (раздел про
      // организацию меню), поэтому остаётся здесь же, рядом с "Обзором",
      // а не в "Складских операциях".
      { key: "stock", path: "/stock", label: "Остатки плёнки" },
    ],
  },
  {
    key: "warehouse",
    label: "Складские операции",
    items: [
      { key: "receive", path: "/m/receive", label: "Приёмка плёнки", permissions: ["units.receive"] },
      { key: "issue", path: "/m/issue", label: "Выдача участку", permissions: ["units.issue"] },
      { key: "storage", path: "/storage", label: "Стеллажи и ячейки" },
      { key: "inventory", path: "/inventory", label: "Инвентаризация", permissions: ["inventory.manage"] },
    ],
  },
  {
    key: "production",
    label: "Производство и Заказы",
    items: [
      { key: "orders", path: "/orders", label: "Заказы покупателей", permissions: ["orders.plan", "orders.manage", "orders.close"] },
      {
        key: "production-tasks",
        path: "/production-tasks",
        label: "Задания цеха (План на день)",
        permissions: ["production_tasks.manage", "production_tasks.view"],
      },
      { key: "purchasing", path: "/purchasing", label: "Закупки плёнки", permissions: ["purchasing.manage"] },
      { key: "reports", path: "/reports", label: "Отчёты", permissions: ["reports.view"] },
    ],
  },
  {
    key: "admin",
    label: "Администрирование",
    items: [
      { key: "users", path: "/users", label: "Пользователи", permissions: ["users.manage"] },
      { key: "roles", path: "/roles", label: "Роли и права", permissions: ["users.manage"] },
      { key: "dictionaries", path: "/dictionaries", label: "Справочники", permissions: ["materials.manage"] },
      { key: "label-template", path: "/label-template", label: "Макет этикетки (100×40)", permissions: ["labels.manage"] },
      { key: "calc-settings", path: "/calc-settings", label: "Параметры расчётов", permissions: ["calc_settings.manage"] },
    ],
  },
  {
    // Постоянный раздел для незрелых/экспериментальных функций (раздел
    // про организацию меню) — видимость каждого пункта по-прежнему решает
    // его permissions, раздел сам по себе не ограничивает доступ, только
    // визуально обособляет "черновое" от основного функционала.
    key: "drafts",
    label: "Черновики функций",
    items: [
      { key: "sales-calculator", path: "/sales-calculator", label: "Калькулятор заказа", permissions: ["sales_calculator.view"] },
    ],
  },
];

export const allNav = navTree.flatMap((block) => block.items);
