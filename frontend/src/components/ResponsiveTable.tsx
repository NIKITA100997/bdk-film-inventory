import { useCallback, useEffect, useState } from "react";
import { Table, Card, Space, Empty, Pagination, Button } from "antd";
import { FileExcelOutlined, PrinterOutlined } from "@ant-design/icons";
import type { TableProps, TablePaginationConfig } from "antd";
import { Grid } from "antd";
import { useColumnSettings, ColumnSettingsButton, type ColumnOption } from "./ColumnSettings";
import { usePersistentState } from "../hooks/usePersistentState";
import { exportToExcel } from "../utils/excel";
import { printReport } from "../utils/printReport";
import { exportValue, nodeText } from "../utils/nodeText";

type Column<T> = NonNullable<TableProps<T>["columns"]>[number];

function columnKey<T>(col: Column<T>, index: number): string {
  const withKey = col as { key?: React.Key; dataIndex?: string | string[] };
  if (withKey.key != null) return String(withKey.key);
  if (typeof withKey.dataIndex === "string") return withKey.dataIndex;
  if (typeof col.title === "string" && col.title) return col.title;
  return `col-${index}`;
}

/** Строки с вложенными (группы, 20.10) — подряд: группа, затем её строки;
 * для Excel, печати и карточек на узком экране. */
function flatTree<T extends object>(list: readonly T[]): T[] {
  return list.flatMap((r) => {
    const kids = (r as { children?: unknown }).children;
    return Array.isArray(kids) ? [r, ...flatTree(kids as T[])] : [r];
  });
}

/** Обёртка над antd Table (раздел про адаптацию под планшет) — на узких
 * экранах таблицы с большим числом колонок листались влево/вправо, что
 * оказалось хуже, чем сама теснота: на широких экранах рендерит обычный
 * Table без изменений, на узких — по тем же columns (title+render, как
 * они уже везде написаны в проекте) собирает карточку на строку: подпись
 * колонки слева, значение справа, друг под другом. Колонки без title
 * (обычно последняя, с кнопками действий) идут внизу карточки без
 * подписи. Тот же набор пропсов, что у Table — замена только импорта и
 * тега, columns переписывать не нужно.
 *
 * Настройка столбцов (шестерёнка, раздел про планшет — карточка
 * растягивалась на весь экран у таблиц с 6+ колонок) — опционально,
 * включается через tableKey: набор видимых столбцов свой у каждого
 * сотрудника (useColumnSettings — общий хук с ReportTable, один и тот же
 * значок вместо двух разных способов выбрать столбцы). lockedColumns
 * нельзя скрыть — обычно это колонка-идентификатор строки и "Действия".
 * defaultHiddenColumns задают стартовый набор для тех, кто ещё не
 * настраивал таблицу под себя. Скрытые столбцы всё равно можно
 * подсмотреть — на карточке есть разворот "ещё N полей", не меняющий
 * сохранённую настройку (в отличие от ReportTable, где скрытый столбец
 * пропадает и из печатной формы/CSV — там подглядывать нечего). */
export default function ResponsiveTable<T extends object>({
  columns,
  dataSource,
  rowKey,
  cardBreakpoint = "sm",
  locale,
  loading,
  tableKey,
  lockedColumns,
  defaultHiddenColumns,
  exportTitle,
  exportNote,
  stickyColumns = 0,
  cardTitleColumn,
  cardCollapsedColumns = [],
  ...rest
}: TableProps<T> & {
  /** Карточка на узком экране (16.10): какой столбец — заголовок карточки
   * (жирным, без подписи). По умолчанию — первый из «Деталь», «Позиция»,
   * «Название», «Что», «Наименование», «Рулон», «Плёнка», иначе первый столбец. */
  cardTitleColumn?: string;
  cardBreakpoint?: "xs" | "sm" | "md" | "lg" | "xl";
  cardCollapsedColumns?: string[];
  tableKey?: string;
  lockedColumns?: string[];
  defaultHiddenColumns?: string[];
  /** Отчёт (05.10): над таблицей «Excel» и «Печать» — по видимым столбцам,
   * значения — как на экране. Заголовок печатной формы и имя файла. */
  exportTitle?: string;
  /** Строка под заголовком печати и в шапке Excel (13.10: комментарий заказа). */
  exportNote?: string;
  /** Сколько первых видимых столбцов закрепить слева при прокрутке вбок
   * (05.10: на планшете широкая таблица теряла, о какой строке речь). */
  stickyColumns?: number;
}) {
  const screens = Grid.useBreakpoint();

  // Раздел про обрезание таблицы в узкой боковой панели на планшете
  // (Issue.tsx, правая колонка Col lg={9} — реальная ширина ~350-450px при
  // viewport ~1024-1194px) — Grid.useBreakpoint() смотрит на ширину ВСЕГО
  // viewport, а не контейнера, в который реально отрисован компонент, из-за
  // чего широкий viewport с узкой колонкой всё равно выбирал wide=true.
  // Меряем реальный контейнер через ResizeObserver; callback-ref (не
  // useRef+пустой deps) — чтобы переподписываться, когда DOM-узел меняется
  // при переключении между card/table ветками ниже. До первого измерения
  // — как раньше, по viewport, чтобы не мигало на первом рендере.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainerEl(node);
  }, []);
  useEffect(() => {
    if (!containerEl) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [containerEl]);

  const BREAKPOINT_PX = { xs: 0, sm: 576, md: 768, lg: 992, xl: 1200, xxl: 1600 } as const;
  const wide = containerWidth != null ? containerWidth >= BREAKPOINT_PX[cardBreakpoint] : (screens[cardBreakpoint] ?? true);

  // Отделяем pagination и onChange, чтобы централизованно управлять размером страницы
  // и текущей страницей как в обычном Table на широких экранах, так и в карточках.
  const { pagination: rawPagination, onChange: rawTableOnChange, ...tableRest } = rest;
  const paginationProp = rawPagination;
  const paginationEnabled = paginationProp !== false;
  const paginationConfig = typeof paginationProp === "object" && paginationProp ? paginationProp : {};
  const isControlledPage = paginationConfig.current !== undefined;
  const isControlledPageSize = paginationConfig.pageSize !== undefined && paginationConfig.onChange !== undefined;

  // Если задан tableKey — запоминаем выбранный размер страницы в localStorage для этого экрана
  const [persistedPageSize, setPersistedPageSize] = usePersistentState<number | null>(
    tableKey ? `table.pagesize.${tableKey}` : "",
    null,
  );
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState<number | null>(() => {
    if (tableKey && persistedPageSize != null && persistedPageSize > 0) {
      return persistedPageSize;
    }
    return null;
  });

  useEffect(() => {
    if (tableKey && persistedPageSize != null && persistedPageSize > 0) {
      setLocalPageSize(persistedPageSize);
    }
  }, [tableKey, persistedPageSize]);

  useEffect(() => {
    setLocalPage(1);
  }, [dataSource]);

  const updatePageSize = useCallback((newSize: number) => {
    setLocalPageSize(newSize);
    if (tableKey) {
      setPersistedPageSize(newSize);
    }
  }, [tableKey, setPersistedPageSize]);

  const effectivePageSize = isControlledPageSize
    ? paginationConfig.pageSize!
    : (localPageSize ?? paginationConfig.pageSize ?? paginationConfig.defaultPageSize ?? 20);

  const totalItems = paginationConfig.total !== undefined ? paginationConfig.total : flatTree(dataSource ?? []).length;
  const totalPages = Math.max(1, Math.ceil(totalItems / effectivePageSize));
  const currentPage = Math.min(isControlledPage ? paginationConfig.current! : localPage, totalPages);

  const defaultPageSizeOptions = ["10", "20", "30", "50", "100", "200"];
  const rawPageSizeOptions = paginationConfig.pageSizeOptions ?? defaultPageSizeOptions;
  const optionsSet = new Set(rawPageSizeOptions.map(String));
  if (effectivePageSize && !optionsSet.has(String(effectivePageSize))) {
    optionsSet.add(String(effectivePageSize));
  }
  const pageSizeOptions = Array.from(optionsSet).sort((a, b) => Number(a) - Number(b));

  const mergedPagination: TablePaginationConfig | false = paginationEnabled
    ? {
        showSizeChanger: true,
        pageSizeOptions,
        locale: { items_per_page: "/ стр." },
        ...paginationConfig,
        current: currentPage,
        pageSize: effectivePageSize,
        onChange: (page: number, size: number) => {
          if (!isControlledPage) {
            setLocalPage(page);
          }
          if (size && size !== effectivePageSize) {
            updatePageSize(size);
            if (!isControlledPage) {
              setLocalPage(1);
            }
          }
          paginationConfig.onChange?.(page, size);
        },
        onShowSizeChange: (_curr: number, size: number) => {
          if (size && size !== effectivePageSize) {
            updatePageSize(size);
            if (!isControlledPage) {
              setLocalPage(1);
            }
          }
          paginationConfig.onShowSizeChange?.(1, size);
        },
      }
    : false;

  const handleTableChange: TableProps<T>["onChange"] = (pag, filters, sorter, extra) => {
    if (pag && pag.pageSize && pag.pageSize !== effectivePageSize) {
      updatePageSize(pag.pageSize);
      if (!isControlledPage) {
        setLocalPage(1);
      }
    } else if (pag && pag.current && pag.current !== localPage) {
      if (!isControlledPage) {
        setLocalPage(pag.current);
      }
    }
    rawTableOnChange?.(pag, filters, sorter, extra);
  };

  const onRow = rest.onRow as TableProps<T>["onRow"];

  const cols = (columns ?? []) as Column<T>[];
  const labelable = cols.filter((c) => c.title);
  const unlabelable = cols.filter((c) => !c.title);
  const locked = new Set(lockedColumns ?? []);

  const columnOptions: ColumnOption[] = labelable.map((c, i) => ({
    key: columnKey(c, i),
    label: c.title as string,
    locked: locked.has(columnKey(c, i)),
  }));
  const settings = useColumnSettings(tableKey, columnOptions, defaultHiddenColumns ?? []);

  const visibleLabelable = labelable.filter((c, i) => settings.isVisible(columnKey(c, i)));
  const hiddenLabelable = labelable.filter((c, i) => !settings.isVisible(columnKey(c, i)));
  const cardCollapsedSet = new Set(cardCollapsedColumns);

  const cellValue = (col: Column<T>, record: T, index: number): React.ReactNode => {
    const dataIndex = (col as { dataIndex?: string | string[] }).dataIndex;
    const raw = typeof dataIndex === "string" ? (record as Record<string, unknown>)[dataIndex] : undefined;
    if (!col.render) return raw as React.ReactNode;
    const rendered = col.render(raw, record, index);
    // render может вернуть {props, children} для объединения ячеек
    // (antd RenderedCell) — в карточках такого объединения нет, берём
    // только содержимое.
    if (rendered && typeof rendered === "object" && "children" in rendered) {
      return (rendered as { children: React.ReactNode }).children;
    }
    return rendered as React.ReactNode;
  };

  // печать — текст как на экране; Excel — числа числами (20.10: срок «20.10»
  // в печати выходил «20.1»)
  const exportData = (asText = false) => {
    const cols = visibleLabelable.map((c, i) => ({ key: `c${i}`, header: nodeText(c.title as React.ReactNode), col: c }));
    const rows = flatTree(dataSource ?? []).map((r, ri) =>
      Object.fromEntries(
        cols.map((c) => {
          const text = nodeText(cellValue(c.col, r, ri));
          return [c.key, asText ? text : exportValue(text)];
        }),
      ),
    );
    return { cols: cols.map(({ key, header }) => ({ key, header })), rows };
  };
  const fileName = `${(exportTitle ?? "").replace(/[\/:*?"<>|]/g, " ").trim()} ${new Date().toISOString().slice(0, 10)}`;

  const settingsBar = (settings.enabled || exportTitle) && (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
      <Space wrap size={6}>
        {exportTitle && (
          <>
            <Button
              size="small"
              icon={<FileExcelOutlined />}
              disabled={!(dataSource ?? []).length}
              onClick={() => {
                const { cols, rows } = exportData();
                exportToExcel(fileName, rows, cols as { key: keyof (typeof rows)[number]; header: string }[], [exportTitle, exportNote ?? ""]);
              }}
            >
              Excel
            </Button>
            <Button
              size="small"
              icon={<PrinterOutlined />}
              disabled={!(dataSource ?? []).length}
              onClick={() => {
                const { cols, rows } = exportData(true);
                printReport(exportTitle, cols, rows, exportNote);
              }}
            >
              Печать
            </Button>
          </>
        )}
      </Space>
      {settings.enabled && <ColumnSettingsButton columns={columnOptions} settings={settings} />}
    </div>
  );

  if (wide || !columns) {
    return (
      <div ref={containerRef}>
        {settingsBar}
        <Table<T>
          columns={[
            ...visibleLabelable.map((c, i) => (i < stickyColumns ? { ...c, fixed: "left" as const } : c)),
            ...unlabelable,
          ]}
          dataSource={dataSource}
          rowKey={rowKey}
          locale={locale}
          loading={loading}
          {...tableRest}
          pagination={mergedPagination}
          onChange={handleTableChange}
        />
      </div>
    );
  }

  const rows = flatTree(dataSource ?? []);
  const TITLE_WORDS = ["деталь", "позиция", "название", "наименование", "что", "рулон", "плёнка", "задание"];
  const titleIndex = (() => {
    const byKey = cardTitleColumn ? visibleLabelable.findIndex((c, i) => columnKey(c, i) === cardTitleColumn) : -1;
    if (byKey >= 0) return byKey;
    for (const w of TITLE_WORDS) {
      const i = visibleLabelable.findIndex((c) => typeof c.title === "string" && c.title.toLowerCase().startsWith(w));
      if (i >= 0) return i;
    }
    return 0;
  })();
  const cardCollapsedLabelable = visibleLabelable.filter((c) => {
    const sourceIndex = labelable.indexOf(c);
    return cardCollapsedSet.has(columnKey(c, sourceIndex)) && visibleLabelable.indexOf(c) !== titleIndex;
  });
  const cardExtraFields = [...cardCollapsedLabelable, ...hiddenLabelable];
  const pageSize = effectivePageSize;
  const cardTotalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const cardCurrentPage = Math.min(isControlledPage ? paginationConfig.current! : localPage, cardTotalPages);
  const pagedRows = paginationEnabled ? rows.slice((cardCurrentPage - 1) * pageSize, cardCurrentPage * pageSize) : rows;

  const handlePageChange = (page: number, size: number) => {
    if (!isControlledPage) {
      setLocalPage(page);
    }
    if (size && size !== effectivePageSize) {
      updatePageSize(size);
      if (!isControlledPage) {
        setLocalPage(1);
      }
    }
    paginationConfig.onChange?.(page, size);
  };

  const getKey = (record: T, index: number): string => {
    if (typeof rowKey === "function") return String(rowKey(record, index));
    if (typeof rowKey === "string") return String((record as Record<string, unknown>)[rowKey]);
    return String(index);
  };

  if (rows.length === 0) {
    return (
      <div ref={containerRef}>
        {settingsBar}
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={(locale as { emptyText?: string })?.emptyText ?? "Нет данных"} />
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      {settingsBar}
      <Space orientation="vertical" size={8} style={{ width: "100%" }}>
        {pagedRows.map((record, localIndex) => {
          const index = paginationEnabled ? (cardCurrentPage - 1) * pageSize + localIndex : localIndex;
          return (
            <PlanCard
              key={getKey(record, index)}
              record={record}
              index={index}
              titleIndex={titleIndex}
              visibleLabelable={visibleLabelable}
              cardCollapsedLabelable={cardCollapsedLabelable}
              hiddenLabelable={cardExtraFields}
              unlabelable={unlabelable}
              cellValue={cellValue}
              loading={typeof loading === "boolean" ? loading : undefined}
              rowProps={onRow?.(record, index)}
            />
          );
        })}
      </Space>
      {paginationEnabled && rows.length > 0 && (!paginationConfig.hideOnSinglePage || rows.length > pageSize) && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <Pagination
            size="small"
            current={cardCurrentPage}
            pageSize={pageSize}
            total={rows.length}
            showSizeChanger={paginationConfig.showSizeChanger ?? true}
            pageSizeOptions={pageSizeOptions}
            locale={{ items_per_page: "/ стр." }}
            onChange={handlePageChange}
          />
        </div>
      )}
    </div>
  );
}

function PlanCard<T extends object>({
  record,
  index,
  titleIndex,
  visibleLabelable,
  cardCollapsedLabelable,
  hiddenLabelable,
  unlabelable,
  cellValue,
  loading,
  rowProps,
}: {
  record: T;
  index: number;
  titleIndex: number;
  visibleLabelable: Column<T>[];
  cardCollapsedLabelable: Column<T>[];
  hiddenLabelable: Column<T>[];
  unlabelable: Column<T>[];
  cellValue: (col: Column<T>, record: T, index: number) => React.ReactNode;
  loading?: boolean;
  // onRow (раздел про клики по строке — "Остатки" на телефоне, где строка
  // ведёт на карточку единицы/материала) — тот же обработчик, что и у
  // обычной Table, только применённый к карточке целиком вместо <tr>.
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const [peekOpen, setPeekOpen] = useState(false);
  // 16.10: заголовок карточки — главное поле строки; остальные — сеткой
  // «подпись над значением» (на телефоне 2 колонки, на планшете 3–4),
  // а не столбиком по строке на поле — карточка втрое короче.
  const titleCol = visibleLabelable[titleIndex];
  const fields = visibleLabelable.filter((col, i) => i !== titleIndex && !cardCollapsedLabelable.includes(col));
  return (
    <Card
      size="small"
      loading={loading}
      className="rt-card"
      {...rowProps}
      style={{ ...(rowProps?.onClick ? { cursor: "pointer" } : undefined), ...rowProps?.style }}
    >
      {titleCol && <div className="rt-card-title">{cellValue(titleCol, record, index)}</div>}
      {fields.length > 0 && (
        <div className="rt-card-grid">
          {fields.map((col, ci) => (
            <div key={ci} className="rt-card-field">
              <span className="rt-card-label">{col.title as React.ReactNode}</span>
              <span className="rt-card-value">{cellValue(col, record, index)}</span>
            </div>
          ))}
        </div>
      )}
      {unlabelable.length > 0 && (
        <div className="rt-card-actions">
          {unlabelable.map((col, ci) => (
            <div key={`action-${ci}`}>{cellValue(col, record, index)}</div>
          ))}
        </div>
      )}
      {hiddenLabelable.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <button type="button" className="rt-card-peek" onClick={() => setPeekOpen((v) => !v)} aria-expanded={peekOpen}>
            {peekOpen ? "скрыть ▴" : `ещё ${hiddenLabelable.length} ${hiddenLabelable.length === 1 ? "поле" : "поля"} ▾`}
          </button>
          {peekOpen && (
            <div className="rt-card-grid" style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed #E2DFD6" }}>
              {hiddenLabelable.map((col, ci) => (
                <div key={ci} className="rt-card-field">
                  <span className="rt-card-label">{col.title as React.ReactNode}</span>
                  <span className="rt-card-value">{cellValue(col, record, index)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
