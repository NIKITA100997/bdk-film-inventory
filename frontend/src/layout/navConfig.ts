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
      // Типы и правила, детали п/ф, модели (BOM) — вкладки этого же экрана,
      // отдельными пунктами меню не дублируются (объединение экранов, 29.09).
    ],
  },
  {
    key: "warehouse",
    label: "Склад",
    items: [
      { key: "receive", path: "/m/receive", label: "Приёмка плёнки", permissions: ["units.receive"] },
      // «Начальные остатки» — режим «Без документа» в Приёмке (объединение экранов, 29.09).
      { key: "issue", path: "/m/issue", label: "Выдача участку", permissions: ["units.issue", "units.return"] },
      // Сверка рулонов — работа кладовщика (перенесена из «Задания цеха», 30.09).
      { key: "roll-reconciliation", path: "/roll-reconciliation", label: "Сверка", permissions: ["units.issue", "units.return", "production_tasks.manage", "reports.view"] },
      // Единые «Остатки»: плёнка и п/ф, позиции, партии, движения, стеллажи
      // и свободный остаток плёнки — вкладками (pages/desktop/Stock.tsx);
      // старые адреса (/blanks, /part-units, /storage…) ведут туда же.
      { key: "stock", path: "/stock", label: "Остатки" },
      // «Места хранения» (все стеллажи) — вкладка «Стеллажи» у вида «Всё» в Остатках.
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
        key: "planner",
        path: "/planner",
        label: "Планировщик",
        permissions: ["production_tasks.manage", "production_tasks.view", "production_tasks.report"],
      },
      {
        key: "production-tasks",
        path: "/production-tasks",
        label: "Задания цеха",
        permissions: ["production_tasks.manage", "production_tasks.view", "production_tasks.report"],
      },
      // «Потребность»: п/ф, плёнка, комплектующие — вкладками одного экрана (30.09).
      {
        key: "demand",
        path: "/demand",
        label: "Потребность",
        permissions: ["production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view", "units.issue"],
      },
      // Участки и линии — один экран устройства цеха (30.09; участки раньше были в «Администрировании»).
      { key: "areas", path: "/areas", label: "Участки и линии", permissions: ["users.manage", "production_tasks.manage"] },
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
      {
        key: "order-readiness",
        path: "/order-readiness",
        label: "Готовность заказов",
        permissions: ["sales_calculator.view", "production_tasks.manage", "production_tasks.view", "production_tasks.report"],
      },
    ],
  },
  {
    key: "analytics",
    label: "Аналитика",
    items: [
      { key: "reports", path: "/reports", label: "Отчёты", permissions: ["reports.view"] },
      { key: "action-log", path: "/action-log", label: "Журнал действий", permissions: ["reports.view"] },
    ],
  },
  {
    key: "admin",
    label: "Администрирование",
    items: [
      { key: "users", path: "/users", label: "Пользователи", permissions: ["users.manage"] },
      { key: "roles", path: "/roles", label: "Роли и права", permissions: ["users.manage"] },
      { key: "deletion-requests", path: "/deletion-requests", label: "Заявки на удаление", permissions: ["users.manage"] },
      // Настройки: параметры расчётов и макет этикетки — вкладками (30.09).
      { key: "settings", path: "/settings", label: "Настройки", permissions: ["calc_settings.manage", "labels.manage"] },
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

/** Мастер участка: участок закреплён и отчитывается о производстве. Ему —
 * короткое меню (30.09, проверка с планшета); полное дерево включается в
 * меню пользователя. Право управлять заданиями не учитываем: на проде у
 * роли «Начальник участка» оно есть, а начальник цеха без участка. */
export function isMasterUser(user: CurrentUser): boolean {
  return !user.is_superuser && !!user.area && user.permissions.includes("production_tasks.report");
}

export const masterNav: NavItem[] = [
  { key: "my-area", path: "/production-tasks", label: "Мой участок" },
  { key: "my-tasks", path: "/production-tasks?tab=tasks", label: "Задания" },
  { key: "scan-roll", path: "/m/unit-card", label: "Скан рулона", permissions: ["units.cut", "units.return", "units.issue"] },
  { key: "scan-pf", path: "/m/part-unit-card", label: "Скан партии п/ф", permissions: ["part_units.manage", "part_units.view", "part_units.correct"] },
  { key: "pf-stock", path: "/stock?kind=pf", label: "Остатки п/ф", permissions: ["part_units.manage", "part_units.view"] },
];
