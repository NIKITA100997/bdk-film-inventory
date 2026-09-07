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
  {
    key: "main",
    label: "Основное",
    items: [
      { key: "overview", path: "/", label: "Обзор" },
      // Сквозная справка "что у нас есть" для всех ролей (продажник,
      // производство, склад) — не складская операция (раздел про
      // организацию меню), поэтому остаётся здесь же, рядом с "Обзором",
      // а не в "Материалах".
      { key: "stock", path: "/stock", label: "Остатки плёнки" },
    ],
  },
  {
    key: "materials",
    label: "Материалы (плёнка)",
    items: [
      { key: "receive", path: "/m/receive", label: "Приёмка плёнки", permissions: ["units.receive"] },
      { key: "initial-stock", path: "/m/initial-stock", label: "Начальные остатки", permissions: ["units.receive"] },
      { key: "issue", path: "/m/issue", label: "Выдача участку", permissions: ["units.issue", "units.return"] },
      { key: "blanks", path: "/blanks", label: "Свободный остаток", permissions: ["units.issue"] },
      { key: "storage", path: "/storage", label: "Стеллажи и полки" },
      {
        key: "warehouse-transfers",
        path: "/warehouse-transfers",
        label: "Перемещения между складами",
        permissions: ["warehouse_transfers.manage"],
      },
      { key: "inventory", path: "/inventory", label: "Инвентаризация", permissions: ["inventory.manage"] },
      { key: "purchasing", path: "/purchasing", label: "Закупки плёнки", permissions: ["purchasing.manage"] },
    ],
  },
  {
    // Раздел про физический учёт деталей (пилот: окутка царговых) —
    // регистрация партий п/ф начальником цеха, отдельно от заданий
    // конкретного участка (резка дерева сегодня нигде не участок).
    // Свой домен-блок (не под-пункт "Производства") — растёт независимо,
    // следующие шаги (адресное хранение/QR) не должны толкаться локтями
    // с ежедневной работой цеха в одном пункте меню.
    key: "parts-domain",
    label: "Детали / П/Ф",
    items: [{ key: "part-units", path: "/part-units", label: "Учёт п/ф", permissions: ["part_units.manage", "part_units.view"] }],
  },
  {
    key: "production",
    label: "Производство",
    items: [
      {
        key: "production-tasks",
        path: "/production-tasks",
        label: "Задания цеха (План на день)",
        permissions: ["production_tasks.manage", "production_tasks.view"],
      },
      // Линии — не конфигурация в стороне, а часть производства: та же
      // область, что "Задания цеха", просто отдельный пункт вместо вкладки
      // (раздел про адаптацию под планшет — линии трогаются не каждый
      // день, но это всё ещё производство, не администрирование).
      { key: "production-lines", path: "/production-lines", label: "Линии цеха", permissions: ["production_tasks.manage"] },
    ],
  },
  {
    // Раздел продажника — вырос из "Черновиков функций" (там был только
    // поиск остатка/аналогов, без расчёта). Теперь полноценный калькулятор
    // заказа (несколько дверей/цветов, погонаж, остаток/резерв по складу),
    // достаточно самостоятельная функция, чтобы не жить рядом с
    // экспериментами — свой блок, как у производства/склада.
    key: "sales",
    label: "Продажи и заказы",
    items: [
      { key: "sales-calculator", path: "/sales-calculator", label: "Калькулятор заказа", permissions: ["sales_calculator.view"] },
    ],
  },
  {
    // Сквозное для всех ролей (не только "Производство"), поэтому свой
    // блок, а не под-пункт — было в "Основном" по прямому запросу
    // пользователя, но с ростом числа доменов "Основное" должно остаться
    // стартовой точкой, а не расти вместе с отчётами каждого нового домена.
    key: "analytics",
    label: "Аналитика",
    items: [
      { key: "reports", path: "/reports", label: "Отчёты", permissions: ["reports.view"] },
      { key: "defects", path: "/defects", label: "Брак и списания", permissions: ["reports.view"] },
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
      { key: "dictionaries", path: "/dictionaries", label: "Справочники", permissions: ["materials.manage"] },
      // Модели — вынесены из вкладок "Заданий цеха" (раздел про адаптацию
      // под планшет и разделение "конфигурации" и "ежедневной работы") —
      // рядом со "Справочниками" по той же логике: BOM трогается редко,
      // при постановке нового изделия, не каждый день.
      { key: "product-models", path: "/product-models", label: "Модели продукции (BOM)", permissions: ["production_tasks.manage"] },
      { key: "parts", path: "/parts", label: "Детали (справочник)", permissions: ["production_tasks.manage"] },
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
