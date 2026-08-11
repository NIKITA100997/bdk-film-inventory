export type UserRole =
  | "nachalnik_tsekha"
  | "nachalnik_uchastka"
  | "operator_sklada"
  | "kladovshchik"
  | "snabzhenets"
  | "logist"
  | "admin"
  | "prodazhnik";

export type Area = "okutka_tsargovykh" | "shchitovye_dveri" | "tselnolistovye_dveri";

export interface CurrentUser {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  area: Area | null;
  is_active: boolean;
}
