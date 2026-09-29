import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { groupPath, groupWithDescendants, listItemGroups, listItems, type ItemGroup } from "../api/items";

/** Отборы и разбивка по группам для экранов с деталями п/ф (остатки,
 * партии, потребность): направление, группа (с подгруппами), стадия — из
 * номенклатуры; выбор общий для этих экранов и живёт до закрытия вкладки. */
export type PfFilter = { direction?: string; group?: number; stage?: string; grouped: boolean };
export type PfAttrs = { groupId: number | null; direction: string | null; stage: string | null };

const KEY = "pf-filter";
const NO_GROUP = "Без группы";

function load(): PfFilter {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? { grouped: true, ...JSON.parse(raw) } : { grouped: true };
  } catch {
    return { grouped: true };
  }
}

export function usePfFilter(): [PfFilter, (f: PfFilter) => void] {
  const [f, setF] = useState<PfFilter>(load);
  const set = (next: PfFilter) => {
    setF(next);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* без хранилища — просто не запоминаем */
    }
  };
  return [f, set];
}

/** Признаки деталей п/ф по id детали (Part) — из номенклатуры. */
export function usePfIndex() {
  const items = useQuery({ queryKey: ["items", false], queryFn: () => listItems({ include_inactive: false }) });
  const groupsQ = useQuery({ queryKey: ["item-groups"], queryFn: listItemGroups });
  const groups = useMemo(() => groupsQ.data ?? [], [groupsQ.data]);
  const byPart = useMemo(() => {
    const m = new Map<number, PfAttrs>();
    for (const i of items.data ?? []) {
      if (i.source_type === "part" && i.source_id != null) {
        m.set(i.source_id, { groupId: i.group_id, direction: i.direction ?? null, stage: i.stage ?? null });
      }
    }
    return m;
  }, [items.data]);
  return { byPart, groups };
}

/** Строки, прошедшие отборы. partOf — id детали строки. */
export function filterPf<T>(rows: T[], partOf: (r: T) => number | null | undefined, f: PfFilter, byPart: Map<number, PfAttrs>, groups: ItemGroup[]): T[] {
  if (!f.direction && f.group == null && !f.stage) return rows;
  const inGroup = f.group != null ? groupWithDescendants(groups, f.group) : null;
  return rows.filter((r) => {
    const pid = partOf(r);
    const a = pid != null ? byPart.get(pid) : undefined;
    if (!a) return false;
    if (f.direction && a.direction !== f.direction) return false;
    if (f.stage && a.stage !== f.stage) return false;
    if (inGroup && (a.groupId == null || !inGroup.has(a.groupId))) return false;
    return true;
  });
}

export type PfSection<T> = { key: string; title: string | null; rows: T[] };

/** Разбивка по группам номенклатуры (путь «Щитовые / Каркасы»), «Без группы» — в конце. */
export function sectionsPf<T>(rows: T[], partOf: (r: T) => number | null | undefined, f: PfFilter, byPart: Map<number, PfAttrs>, groups: ItemGroup[]): PfSection<T>[] {
  if (!f.grouped) return [{ key: "all", title: null, rows }];
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const pid = partOf(r);
    const gid = pid != null ? byPart.get(pid)?.groupId ?? null : null;
    const title = gid != null ? groupPath(groups, gid) || NO_GROUP : NO_GROUP;
    by.set(title, [...(by.get(title) ?? []), r]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === NO_GROUP ? 1 : b === NO_GROUP ? -1 : a.localeCompare(b, "ru")))
    .map(([title, rs]) => ({ key: title, title, rows: rs }));
}

