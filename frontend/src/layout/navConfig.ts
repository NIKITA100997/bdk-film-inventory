import type { Area, CurrentUser } from "../auth/types";

export interface NavItem {
  key: string;
  path: string;
  label: string;
  permissions?: string[];
  areas?: Area[];
}

export interface NavBlock {
  key: string;
  label: string;
  items: NavItem[];
}

/** Единое навигационное дерево Супер-Хабов.
 * Основные рабочие центры (Главная, Заказы, Производство, Склад, Закупки, Аналитика) —
 * плоские пункты меню верхнего уровня без выпадающих списков для моментального
 * перехода в 1 тап на планшетах и компьютерах.
 * Редкие конфигурационные экраны собраны в выпадающее меню «Настройки». */
export const navTree: NavBlock[] = [
  // 1. Плоские пункты верхнего уровня (Супер-Хабы без выпадающих подменю)
  {
    key: "hubs",
    label: "",
    items: [
      { key: "home", path: "/", label: "🏠 Главная" },
      {
        key: "orders",
        path: "/customer-orders",
        label: "📑 Заказы",
        permissions: [
          "production_tasks.manage",
          "production_tasks.view",
          "production_tasks.report",
          "orders.request",
          "sales_calculator.view",
          "plan.approve",
          "fg.ship",
        ],
      },
      {
        key: "production",
        path: "/production-tasks",
        label: "🏭 Производство",
        permissions: [
          "production_tasks.manage",
          "production_tasks.view",
          "production_tasks.report",
        ],
      },
      {
        key: "film",
        path: "/film-operations",
        label: "🎞 Плёнка",
        permissions: ["units.issue", "units.receive", "units.return", "production_tasks.manage", "production_tasks.view", "reports.view"],
      },
      {
        key: "warehouse",
        path: "/stock",
        label: "📦 Склад",
      },
      {
        key: "purchasing",
        path: "/purchasing",
        label: "🛒 Закупки",
        permissions: ["purchasing.manage"],
      },
      {
        key: "analytics",
        path: "/reports",
        label: "📊 Аналитика",
        permissions: ["reports.view"],
      },
    ],
  },

  // 2. Выпадающее меню конфигурации и администрирования
  {
    key: "admin-block",
    label: "⚙️ Настройки",
    items: [
      {
        key: "nomenclature",
        path: "/nomenclature",
        label: "Номенклатура и техкарты",
        permissions: [
          "materials.manage",
          "production_tasks.manage",
          "production_tasks.view",
          "part_units.manage",
          "part_units.view",
        ],
      },
      {
        key: "production-calendar",
        path: "/production-calendar",
        label: "Производственный календарь",
        permissions: ["production_tasks.manage", "production_tasks.view"],
      },
      {
        key: "prices",
        path: "/prices",
        label: "Прайс-листы и цены",
        permissions: ["prices.view", "prices.manage"],
      },
      {
        key: "users",
        path: "/users",
        label: "Пользователи",
        permissions: ["users.manage"],
      },
      {
        key: "roles",
        path: "/roles",
        label: "Роли и права",
        permissions: ["users.manage"],
      },
      {
        key: "requests",
        path: "/requests",
        label: "Запросы на удаление / действия",
        permissions: ["requests.approve", "users.manage"],
      },
      {
        key: "action-log",
        path: "/action-log",
        label: "📜 Журнал действий (отмена списаний)",
        permissions: ["reports.view", "units.correct", "units.writeoff", "users.manage"],
      },
      {
        key: "period-closing",
        path: "/period-closing",
        label: "Закрытие периода",
        permissions: ["period.manage"],
      },
      {
        key: "settings",
        path: "/settings",
        label: "Параметры системы",
        permissions: [
          "calc_settings.manage",
          "labels.manage",
          "prices.manage",
          "users.manage",
          "production_tasks.manage",
        ],
      },
    ],
  },
];

export const allNav = navTree.flatMap((block) => block.items);

export function isNavItemVisible(item: NavItem, user: CurrentUser): boolean {
  if (!user.is_superuser && item.permissions?.length && !item.permissions.some((p) => user.permissions.includes(p))) {
    return false;
  }
  if (item.areas && !(user.area && item.areas.includes(user.area))) return false;
  return true;
}

/** Мастер участка: закреплён за участком и отчитывается о производстве.
 * Ему — ультра-простое короткое меню для планшета. */
export function isMasterUser(user: CurrentUser): boolean {
  if (user.is_superuser || !user.area || !user.permissions.includes("production_tasks.report")) return false;
  return !["units.issue", "units.receive", "production_tasks.all_areas"].some((p) => user.permissions.includes(p));
}

export const masterNav: NavItem[] = [
  { key: "my-area", path: "/production-tasks", label: "🏭 Мой участок" },
  { key: "my-tasks", path: "/production-tasks?tab=tasks", label: "📋 Задания" },
  { key: "scan-roll", path: "/m/unit-card", label: "🔍 Скан рулона", permissions: ["units.cut", "units.return", "units.issue"] },
  { key: "scan-pf", path: "/m/part-unit-card", label: "📦 Скан партии ПФ", permissions: ["part_units.manage", "part_units.view", "part_units.correct"] },
  { key: "pf-stock", path: "/stock?kind=pf", label: "📊 Остатки ПФ", permissions: ["part_units.manage", "part_units.view"] },
  { key: "pf-demand", path: "/demand?tab=pf", label: "⚡ Потребность ПФ", permissions: ["production_tasks.manage", "part_units.manage"] },
];
