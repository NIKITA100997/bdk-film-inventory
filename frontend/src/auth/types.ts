export type Area = "okutka_tsargovykh" | "shchitovye_dveri" | "tselnolistovye_dveri";

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
