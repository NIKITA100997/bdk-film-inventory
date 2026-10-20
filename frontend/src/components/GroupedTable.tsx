import { useMemo, useState, type ReactNode } from "react";
import { Button, Space, Tag, Typography } from "antd";
import type { TableProps } from "antd";
import type { ColumnType, SortOrder } from "antd/es/table/interface";
import { ArrowLeftOutlined, ArrowRightOutlined, CloseOutlined, PlusOutlined } from "@ant-design/icons";
import ResponsiveTable from "./ResponsiveTable";
import { usePersistentState } from "../hooks/usePersistentState";

/** Признак группировки: подпись и значение строки («Размер панели» →
 * «6х810х2010»). */
export interface GroupDim<T> {
  key: string;
  label: string;
  value: (r: T) => string;
}

/** Строка группы: значение признака, строки внутри (все листья), дочерние
 * группы или сами строки. */
export interface GroupNode<T> {
  __group: true;
  key: string;
  dim: GroupDim<T>;
  value: string;
  level: number;
  rows: T[];
  children: Row<T>[];
}
type Row<T> = T | GroupNode<T>;

export type GroupColumn<T> = Omit<ColumnType<T>, "render" | "key"> & {
  key: string;
  render?: (value: unknown, r: T, index: number) => ReactNode;
  /** значение для сортировки по столбцу; нет — столбец не сортируется */
  sortValue?: (r: T) => string | number | null | undefined;
  /** ячейка в строке группы: итог по строкам группы, общий выбор */
  groupRender?: (rows: T[], g: GroupNode<T>) => ReactNode;
};

export const isGroupRow = <T,>(r: unknown): r is GroupNode<T> => !!r && typeof r === "object" && "__group" in (r as object);

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const cmp = (a: unknown, b: unknown): number => {
  const ea = a == null || a === "";
  const eb = b == null || b === "";
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1; // пустое — в конце
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
};

type SortState = { key: string; order: Exclude<SortOrder, null> } | null;

/** Таблица с группировками (20.10, черновик запуска): уровни группировки
 * включаются, выключаются и меняются местами; в строке группы — итоги и
 * общий выбор на все строки внутри (столбец groupRender). Сортировка по
 * столбцам — внутри групп, группы — по значению (или по итогу столбца).
 * Уровни, сортировка — запоминаются на устройстве по storageKey. */
export default function GroupedTable<T extends object>({
  storageKey,
  dims,
  defaultDims,
  columns,
  dataSource,
  rowKey,
  labelColumn,
  rowClassName,
  extra,
  ...rest
}: Omit<TableProps<T>, "columns" | "dataSource" | "rowKey" | "rowClassName"> & {
  storageKey: string;
  dims: GroupDim<T>[];
  defaultDims: string[];
  columns: GroupColumn<T>[];
  dataSource: T[];
  rowKey: (r: T) => string;
  /** столбец, где в строке группы пишется «Признак: значение»; по умолчанию первый с заголовком */
  labelColumn?: string;
  rowClassName?: (r: T) => string;
  /** справа на панели группировки — свои кнопки таблицы */
  extra?: ReactNode;
  exportTitle?: string;
  exportNote?: string;
  cardBreakpoint?: "xs" | "sm" | "md" | "lg";
}) {
  const [active, setActive] = usePersistentState<string[]>(`grp.${storageKey}`, defaultDims);
  const [sort, setSort] = usePersistentState<SortState>(`sort.${storageKey}`, null);
  const used = active.map((k) => dims.find((d) => d.key === k)).filter((d): d is GroupDim<T> => !!d);
  const free = dims.filter((d) => !active.includes(d.key));
  const sortCol = sort ? columns.find((c) => c.key === sort.key && c.sortValue) : undefined;
  const dir = sort?.order === "descend" ? -1 : 1;

  const tree = useMemo(() => {
    const leafSort = (rows: T[]) =>
      sortCol ? [...rows].sort((a, b) => dir * cmp(sortCol.sortValue!(a), sortCol.sortValue!(b))) : rows;
    const groupVal = (rows: T[]) => {
      if (!sortCol) return undefined;
      const vals = rows.map((r) => sortCol.sortValue!(r));
      return vals.every((v) => typeof v === "number") ? (vals as number[]).reduce((s, v) => s + v, 0) : vals.sort(cmp)[0];
    };
    const build = (rows: T[], level: number, prefix: string): Row<T>[] => {
      if (level >= used.length) return leafSort(rows);
      const dim = used[level];
      const by = new Map<string, T[]>();
      for (const r of rows) {
        const v = dim.value(r) ?? "";
        const list = by.get(v);
        if (list) list.push(r);
        else by.set(v, [r]);
      }
      const nodes: GroupNode<T>[] = [...by.entries()].map(([value, list]) => {
        const key = `${prefix}${dim.key}=${value}|`;
        return { __group: true, key, dim, value, level, rows: list, children: build(list, level + 1, key) };
      });
      // группы — по значению признака; при сортировке по столбцу — по его итогу
      return nodes.sort((a, b) => (sortCol ? dir * cmp(groupVal(a.rows), groupVal(b.rows)) || cmp(a.value, b.value) : cmp(a.value, b.value)));
    };
    return build(dataSource, 0, "g:");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, active.join(","), sort?.key, sort?.order]);

  const groupKeys = useMemo(() => {
    const out: string[] = [];
    const walk = (list: Row<T>[]) => {
      for (const r of list) if (isGroupRow<T>(r)) out.push(r.key), walk(r.children);
    };
    walk(tree);
    return out;
  }, [tree]);
  // раскрыто: null — всё (по умолчанию и после смены группировки)
  const [expanded, setExpanded] = useState<{ sig: string; keys: string[] } | null>(null);
  const sig = active.join(",");
  const expandedKeys = expanded && expanded.sig === sig ? expanded.keys : groupKeys;

  const label = labelColumn ?? columns.find((c) => c.title)?.key;
  const cols = columns.map((c): ColumnType<Row<T>> => {
    const { sortValue, groupRender, render, ...col } = c;
    return {
      ...(col as ColumnType<Row<T>>),
      key: c.key,
      ...(sortValue ? { sorter: true, sortOrder: sort?.key === c.key ? sort.order : null, sortDirections: ["ascend", "descend"] as SortOrder[] } : {}),
      render: (v: unknown, r: Row<T>, i: number) => {
        if (isGroupRow<T>(r)) {
          const own = groupRender?.(r.rows, r) ?? null;
          if (c.key !== label) return own;
          return (
            <Space size={6} wrap style={{ paddingLeft: r.level * 4 }}>
              <Typography.Text type="secondary">{r.dim.label}:</Typography.Text>
              <b>{r.value || "—"}</b>
              <Tag style={{ marginInlineEnd: 0 }}>строк {r.rows.length}</Tag>
              {own}
            </Space>
          );
        }
        return render ? render(v, r, i) : (v as ReactNode);
      },
    };
  });

  const move = (k: string, by: number) =>
    setActive((prev) => {
      const i = prev.indexOf(k);
      const j = i + by;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const same = active.length === defaultDims.length && active.every((k, i) => k === defaultDims[i]);

  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <Typography.Text type="secondary">Группировка:</Typography.Text>
        {used.length === 0 && <Typography.Text type="secondary">нет</Typography.Text>}
        {used.map((d, i) => (
          <Tag key={d.key} color="orange" style={{ marginInlineEnd: 0, display: "inline-flex", alignItems: "center", gap: 2 }}>
            <span>
              {i + 1}. {d.label}
            </span>
            <Button type="text" size="small" icon={<ArrowLeftOutlined />} disabled={i === 0} aria-label={`«${d.label}» уровнем выше`} title="Уровнем выше" onClick={() => move(d.key, -1)} />
            <Button
              type="text"
              size="small"
              icon={<ArrowRightOutlined />}
              disabled={i === used.length - 1}
              aria-label={`«${d.label}» уровнем ниже`}
              title="Уровнем ниже"
              onClick={() => move(d.key, 1)}
            />
            <Button type="text" size="small" icon={<CloseOutlined />} aria-label={`Убрать группировку «${d.label}»`} title="Убрать" onClick={() => setActive((p) => p.filter((x) => x !== d.key))} />
          </Tag>
        ))}
        {free.map((d) => (
          <Button key={d.key} size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setActive((p) => [...p, d.key])}>
            {d.label}
          </Button>
        ))}
        {used.length > 0 && (
          <Button size="small" type="link" onClick={() => setActive([])}>
            без группировки
          </Button>
        )}
        {!same && (
          <Button size="small" type="link" onClick={() => setActive(defaultDims)}>
            как по умолчанию
          </Button>
        )}
        {used.length > 0 && (
          <Button
            size="small"
            type="link"
            onClick={() => setExpanded({ sig, keys: expandedKeys.length ? [] : groupKeys })}
          >
            {expandedKeys.length ? "свернуть все" : "раскрыть все"}
          </Button>
        )}
        {sort && (
          <Button size="small" type="link" onClick={() => setSort(null)}>
            сбросить сортировку
          </Button>
        )}
        {extra && <div style={{ marginLeft: "auto" }}>{extra}</div>}
      </div>
      <ResponsiveTable<Row<T>>
        {...(rest as TableProps<Row<T>>)}
        columns={cols}
        dataSource={tree}
        rowKey={(r) => (isGroupRow<T>(r) ? r.key : rowKey(r))}
        rowClassName={(r) => (isGroupRow<T>(r) ? `grp-row grp-l${r.level}` : (rowClassName?.(r) ?? ""))}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: (keys) => setExpanded({ sig, keys: keys as string[] }),
          indentSize: 14,
        }}
        onChange={(_p, _f, s) => {
          const one = Array.isArray(s) ? s[0] : s;
          setSort(one?.order && one.columnKey != null ? { key: String(one.columnKey), order: one.order } : null);
        }}
      />
    </Space>
  );
}
