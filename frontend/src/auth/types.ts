// Раньше 3-значный union под жёсткий enum на бэкенде (раздел про
// администрирование участков) — участков теперь произвольное количество,
// код участка просто строка, живой список — src/api/areas.ts.
export type Area = string;

// Системный код роли (8.3 раздел бэклога доработок) — заполнен только у 7
// ролей, заведённых миграцией; у ролей, созданных через "Роли и права", null.
// Используется точечно (например, чтобы понять "это начальник участка" не
// завязываясь на то, как роль назвали) — для отображения используйте
// RoleSummary.name, не code.
export type SystemRoleCode =
  | "nachalnik_tsekha"
  | "nachalnik_uchastka"
  | "operator_sklada"
  | "kladovshchik"
  | "snabzhenets"
  | "logist"
  | "prodazhnik";

export interface RoleSummary {
  id: number;
  code: SystemRoleCode | null;
  name: string;
}

export interface CurrentUser {
  id: number;
  username: string;
  full_name: string;
  roles: RoleSummary[];
  is_superuser: boolean;
  permissions: string[];
  area: Area | null;
  is_active: boolean;
}
