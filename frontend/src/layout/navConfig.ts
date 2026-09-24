import type { Area, CurrentUser } from "../auth/types";

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
//
// Раздел про реорганизацию по стадии процесса (не по текущему делению) —
// артефакт-дорожная карта https://claude.ai/code/artifact/0b49ac59-3761-413e-8382-32cf72a07366:
// «Производство» смешивало ежедневную работу с редкой конфигурацией и
// разными доменами (плёнка/п/ф) в одном плоском пункте — при росте числа
// доменов (п/ф, дальше — контроль качества, готовая продукция) это стало
// бы свалкой. Три реальных переезда пунктов между блоками: «Учёт п/ф» —
// из «Производство» в свой домен-блок «Детали / П/Ф» (растёт отдельно от
// повседневной работы цеха); «Закупки плёнки» — из «Производство» в
// «Материалы» (снабжение плёнки логически ближе к её складскому учёту,
// чем к исполнению производственных заданий); «Отчёты»/«Брак и списания»
// — из «Основное» в новый блок «Аналитика» (сквозные для всех ролей, но
// не часть стартовой страницы). Остальные пункты — на прежнем месте, «Складские
// операции» просто переименованы в «Материалы (плёнка)» — более точное
// имя домена, раз рядом появился другой материальный домен (детали/п/ф).
// «Готовая продукция и отгрузка» из дорожной карты — намеренно НЕ заведён
// пустым блоком здесь: пустой раздел меню — визуальный шум, не подсказка;
// добавить, когда там появится первый реальный пункт.
export const navTree: NavBlock[] = [
  // Единая модель (24.09.2026): меню по смыслу, а не по видам материала —
  // «Номенклатура» (что у нас есть и как делается), «Склад» (плёнка и п/ф
  // вместе), «Производство» (заказы → задания → потребность), «Закупки».
  // Старые адреса справочников (/parts, /product-models, /door-series)
  // ведут на вкладки «Номенклатуры» — закладки и привычка не ломаются.
  {
    key: "main",
    label: "Основное",
    items: [{ key: "overview", path: "/", label: "Обзор" }],
  },
  {
    key: "nomenclature",
    label: "Номенклатура",
    items: [
      { key: "nomenclature", path: "/nomenclature", label: "Номенклатура и техкарты", permissions: ["materials.manage", "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view"] },
      { key: "item-types", path: "/nomenclature?tab=types", label: "Типы изделий и правила", permissions: ["materials.manage", "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view"] },
      { key: "parts", path: "/nomenclature?tab=parts", label: "Детали п/ф", permissions: ["production_tasks.manage"] },
      { key: "product-models", path: "/nomenclature?tab=models", label: "Модели продукции (BOM)", permissions: ["production_tasks.manage"] },
      { key: "dictionaries", path: "/dictionaries", label: "Материалы, цвета, толщины", permissions: ["materials.manage"] },
    ],
  },
  {
    key: "warehouse",
    label: "Склад",
    items: [
      { key: "general-stock", path: "/general-stock", label: "Общие остатки" },
      { key: "receive", path: "/m/receive", label: "Приёмка плёнки", permissions: ["units.receive"] },
      { key: "initial-stock", path: "/m/initial-stock", label: "Начальные остатки", permissions: ["units.receive"] },
      { key: "issue", path: "/m/issue", label: "Выдача участку", permissions: ["units.issue", "units.return"] },
      // /storage — отдельный роут без пункта меню (скан «Р-…/СШ…» открывает
      // его с видом «Карта»); в меню — только /stock.
      { key: "stock", path: "/stock", label: "Остатки плёнки" },
      { key: "blanks", path: "/blanks", label: "Свободный остаток плёнки", permissions: ["units.issue"] },
      {
        key: "part-stock",
        path: "/part-stock",
        label: "Остатки и стеллажи п/ф",
        permissions: ["part_units.manage", "part_units.view", "part_storage.manage"],
      },
      { key: "part-units", path: "/part-units", label: "Партии п/ф", permissions: ["part_units.manage", "part_units.view"] },
      {
        key: "warehouse-transfers",
        path: "/warehouse-transfers",
        label: "Перемещения между складами",
        permissions: ["warehouse_transfers.manage"],
      },
      { key: "inventory", path: "/inventory", label: "Инвентаризация", permissions: ["inventory.manage"] },
    ],
  },
  {
    key: "production",
    label: "Производство",
    items: [
      {
        key: "production-orders",
        path: "/production-orders",
        label: "Заказы на производство",
        permissions: ["production_tasks.manage", "production_tasks.view", "production_tasks.report"],
      },
      {
        key: "production-tasks",
        path: "/production-tasks",
        label: "Задания цеха (План на день)",
        permissions: ["production_tasks.manage", "production_tasks.view", "production_tasks.report"],
      },
      {
        key: "pf-demand",
        path: "/pf-demand",
        label: "Потребность п/ф",
        permissions: ["production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view"],
      },
      { key: "production-lines", path: "/production-lines", label: "Линии цеха", permissions: ["production_tasks.manage"] },
    ],
  },
  {
    key: "purchasing",
    label: "Закупки",
    items: [{ key: "purchasing", path: "/purchasing", label: "Закупки плёнки", permissions: ["purchasing.manage"] }],
  },
  {
    key: "sales",
    label: "Продажи и заказы",
    items: [
      { key: "sales-calculator", path: "/sales-calculator", label: "Калькулятор заказа", permissions: ["sales_calculator.view"] },
    ],
  },
  {
    key: "analytics",
    label: "Аналитика",
    items: [
      { key: "reports", path: "/reports", label: "Отчёты", permissions: ["reports.view"] },
      { key: "defects", path: "/defects", label: "Брак и списания", permissions: ["reports.view"] },
      { key: "action-log", path: "/action-log", label: "Журнал действий", permissions: ["reports.view"] },
    ],
  },
  {
    key: "admin",
    label: "Администрирование",
    items: [
      { key: "users", path: "/users", label: "Пользователи", permissions: ["users.manage"] },
      { key: "roles", path: "/roles", label: "Роли и права", permissions: ["users.manage"] },
      { key: "areas", path: "/areas", label: "Участки", permissions: ["users.manage"] },
      { key: "deletion-requests", path: "/deletion-requests", label: "Заявки на удаление", permissions: ["users.manage"] },
      { key: "label-template", path: "/label-template", label: "Макет этикетки (100×40)", permissions: ["labels.manage"] },
      { key: "calc-settings", path: "/calc-settings", label: "Параметры расчётов", permissions: ["calc_settings.manage"] },
    ],
  },
];

export const allNav = navTree.flatMap((block) => block.items);

// Раздел про телефонную версию — та же проверка видимости пункта меню,
// что раньше жила только внутри AppLayout.tsx (локальная isVisible),
// вынесена сюда, чтобы PhoneTabBar (список "Ещё") мог использовать ту же
// логику, не дублируя её.
export function isNavItemVisible(item: NavItem, user: CurrentUser): boolean {
  if (!user.is_superuser && item.permissions?.length && !item.permissions.some((p) => user.permissions.includes(p))) {
    return false;
  }
  if (item.areas && !(user.area && item.areas.includes(user.area))) return false;
  return true;
}
