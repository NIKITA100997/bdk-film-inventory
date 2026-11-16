import { apiClient } from "./client";

export interface Area {
  code: string;
  name: string;
  is_active: boolean;
  // Раздел про площадки — id площадки (Северный/Фабрика), если участок к
  // ней привязан; сам склад площадки — в /sites (см. api/sites.ts).
  site_id: number | null;
  // Раздел про отключение распределения по дням — False у участков,
  // которые планируются просто "на участок", без разбивки по дням.
  requires_daily_plan: boolean;
  // Участок как рабочий центр (единая модель, п.5): отчёт по строке с
  // плёнкой — только с рулоном, возврат рулона — только после отчёта.
  requires_roll_on_report: boolean;
  /** Плёнку режут на участке (прессы): выдаётся рулон целиком, ширина не проверяется. */
  film_cut_on_site: boolean;
  /** Планирование: сколько рабочих дней занимает операция участка. */
  lead_days: number;
  /** Мощность (задел): штук в смену (null — не задана) и смен в день. */
  capacity_per_shift: number | null;
  shifts_per_day: number;
  /** Припуск плёнки к ширине детали, мм (Фабрика — 7); null — без припуска. */
  film_allowance_mm: number | null;
  /** Крупные партии операции с плёнкой — предлагать на этот участок от N шт. */
  big_batch_area: string | null;
  big_batch_min_pieces: number | null;
  /** По строкам не отчитываются (Фабрика): задание закрывают целиком «всё сделано». */
  close_without_reports: boolean;
  // Остатки плёнки на склад не возвращаются — рулон отмечают «израсходован».
  film_no_return: boolean;
  /** здесь режут и выдают плёнку (линии участка — станки резки) */
  film_issue_point: boolean;
  /** по каким признакам позиции объединять строки заданий (08.10); пусто — не объединять */
  group_props?: string[] | null;
  /** Оплата работ: piece — сдельно (piece_rate ₽/шт), shift — за смену (shift_rate ₽ на человека × shift_headcount). */
  pay_mode: "piece" | "shift" | null;
  piece_rate: number | null;
  shift_rate: number | null;
  shift_headcount: number | null;
  /** Профиль экрана мастера: auto, wrapping, milling, edgebanding, assembly, packaging, universal */
  master_profile?: MasterProfile | null;
  /** Признак группировки плиток: auto, film, program, edge, series, thickness, order, none */
  group_by_attribute?: GroupByAttribute | null;
  /** Отображение габаритов заготовки (Д x Ш x Т мм) */
  show_dimensions?: boolean;
  /** Отображение программы ЧПУ и тех. указаний */
  show_cnc_program?: boolean;
  /** Отображение параметров кромкооблицовки */
  show_edge_specs?: boolean;
  /** Наличие наладочных пусковых деталей на станке */
  has_pusk_pieces?: boolean;
}

export type MasterProfile =
  | "auto"
  | "wrapping"
  | "milling"
  | "edgebanding"
  | "assembly"
  | "packaging"
  | "universal";

export type GroupByAttribute =
  | "auto"
  | "film"
  | "program"
  | "edge"
  | "series"
  | "thickness"
  | "dimensions"
  | "order"
  | "none";

/** Нужен ли рулон в отчёте на этом участке (настройка участка, не код). */
export function areaRequiresRoll(areas: Area[] | undefined, code: string | null | undefined): boolean {
  return !!areas?.find((a) => a.code === code)?.requires_roll_on_report;
}

export async function listAreas(): Promise<Area[]> {
  const { data } = await apiClient.get<Area[]>("/areas");
  return data;
}

export async function createArea(
  name: string,
  siteId?: number | null,
  requiresDailyPlan?: boolean,
  requiresRollOnReport?: boolean,
  extra?: {
    master_profile?: MasterProfile;
    group_by_attribute?: GroupByAttribute;
    show_dimensions?: boolean;
    show_cnc_program?: boolean;
    show_edge_specs?: boolean;
    has_pusk_pieces?: boolean;
  },
): Promise<Area> {
  const { data } = await apiClient.post<Area>("/areas", {
    name,
    site_id: siteId ?? undefined,
    requires_daily_plan: requiresDailyPlan ?? true,
    requires_roll_on_report: requiresRollOnReport ?? false,
    ...extra,
  });
  return data;
}

export async function updateArea(
  code: string,
  payload: {
    name?: string;
    is_active?: boolean;
    site_id?: number | null;
    requires_daily_plan?: boolean;
    requires_roll_on_report?: boolean;
    film_cut_on_site?: boolean;
    lead_days?: number;
    capacity_per_shift?: number | null;
    shifts_per_day?: number;
    film_allowance_mm?: number;
    big_batch_area?: string;
    big_batch_min_pieces?: number;
    close_without_reports?: boolean;
    film_no_return?: boolean;
    film_issue_point?: boolean;
    group_props?: string[];
    pay_mode?: string;
    piece_rate?: number;
    shift_rate?: number;
    shift_headcount?: number;
    master_profile?: MasterProfile | null;
    group_by_attribute?: GroupByAttribute | null;
    show_dimensions?: boolean;
    show_cnc_program?: boolean;
    show_edge_specs?: boolean;
    has_pusk_pieces?: boolean;
  },
): Promise<Area> {
  const { data } = await apiClient.patch<Area>(`/areas/${code}`, payload);
  return data;
}
