import type { UserRole } from "../auth/types";

export interface NavItem {
  key: string;
  path: string;
  label: string;
  roles: UserRole[];
}

// Мобильные экраны цеха/склада (5.3 ТЗ)
export const mobileNav: NavItem[] = [
  { key: "m-receive", path: "/m/receive", label: "Приёмка", roles: ["operator_sklada"] },
  { key: "m-split", path: "/m/split", label: "Разделить рулон", roles: ["operator_sklada"] },
  { key: "m-issue", path: "/m/issue", label: "Выдача участку", roles: ["operator_sklada"] },
  { key: "m-cut", path: "/m/cut", label: "Раскрой", roles: ["operator_sklada", "nachalnik_uchastka"] },
  { key: "m-return", path: "/m/return", label: "Возврат", roles: ["nachalnik_uchastka", "kladovshchik"] },
  {
    key: "m-search",
    path: "/m/search",
    label: "Поиск остатка",
    roles: ["kladovshchik", "operator_sklada", "nachalnik_uchastka", "logist"],
  },
  { key: "m-place", path: "/m/place", label: "Размещение в ячейку", roles: ["kladovshchik", "operator_sklada"] },
  { key: "m-inventory", path: "/m/inventory", label: "Инвентаризация", roles: ["logist", "kladovshchik"] },
];

// Десктопные экраны снабжения/склада/руководства (5.4 ТЗ)
export const desktopNav: NavItem[] = [
  { key: "d-plan", path: "/plan", label: "Недельный план", roles: ["nachalnik_tsekha"] },
  { key: "d-plan-fact", path: "/plan-fact", label: "План/факт", roles: ["nachalnik_tsekha", "logist"] },
  { key: "d-dashboard", path: "/dashboard", label: "Дашборд остатков", roles: ["logist", "nachalnik_tsekha", "snabzhenets"] },
  { key: "d-materials", path: "/materials", label: "Карточка материала", roles: ["logist", "nachalnik_tsekha", "snabzhenets"] },
  { key: "d-orders", path: "/orders", label: "Заказы", roles: ["logist"] },
  { key: "d-settings", path: "/settings", label: "Настройки", roles: ["admin", "kladovshchik"] },
];

export const allNav = [...mobileNav, ...desktopNav];
