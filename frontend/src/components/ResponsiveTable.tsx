import { useCallback, useEffect, useState } from "react";
import { Table, Card, Space, Empty, Pagination } from "antd";
import type { TableProps } from "antd";
import { Grid } from "antd";
import { useColumnSettings, ColumnSettingsButton, type ColumnOption } from "./ColumnSettings";

type Column<T> = NonNullable<TableProps<T>["columns"]>[number];

function columnKey<T>(col: Column<T>, index: number): string {
  const withKey = col as { key?: React.Key; dataIndex?: string | string[] };
  if (withKey.key != null) return String(withKey.key);
  if (typeof withKey.dataIndex === "string") return withKey.dataIndex;
  if (typeof col.title === "string" && col.title) return col.title;
  return `col-${index}`;
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
  cardBreakpoint = "md",
  locale,
  loading,
  tableKey,
  lockedColumns,
  defaultHiddenColumns,
  ...rest
}: TableProps<T> & {
  cardBreakpoint?: "xs" | "sm" | "md" | "lg";
  tableKey?: string;
  lockedColumns?: string[];
  defaultHiddenColumns?: string[];
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

  // Раздел про пагинацию в карточном режиме — эти хуки должны вызываться
  // безусловно на каждом рендере (Rules of Hooks), поэтому объявлены здесь,
  // до раннего return на широком экране, а не только внутри узкой ветки —
  // иначе смена wide между рендерами меняет число вызванных хуков и роняет
  // React ("Rendered more hooks than during the previous render").
  const paginationProp = rest.pagination;
  const paginationEnabled = paginationProp !== false;
  const paginationConfig = typeof paginationProp === "object" && paginationProp ? paginationProp : {};
  const isControlledPage = paginationConfig.current !== undefined;
  const [localPage, setLocalPage] = useState(1);
  useEffect(() => {
    setLocalPage(1);
  }, [dataSource]);

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

  const settingsBar = settings.enabled && (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
      <ColumnSettingsButton columns={columnOptions} settings={settings} />
    </div>
  );

  if (wide || !columns) {
    return (
      <div ref={containerRef}>
        {settingsBar}
        <Table<T>
          columns={[...visibleLabelable, ...unlabelable]}
          dataSource={dataSource}
          rowKey={rowKey}
          locale={locale}
          loading={loading}
          {...rest}
        />
      </div>
    );
  }

  const rows = dataSource ?? [];

  const pageSize = paginationConfig.pageSize ?? 10;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(isControlledPage ? paginationConfig.current! : localPage, totalPages);
  const pagedRows = paginationEnabled ? rows.slice((currentPage - 1) * pageSize, currentPage * pageSize) : rows;

  const handlePageChange = (page: number, size: number) => {
    if (isControlledPage) {
      paginationConfig.onChange?.(page, size);
    } else {
      setLocalPage(page);
    }
  };

  const getKey = (record: T, index: number): string => {
    if (typeof rowKey === "function") return String(rowKey(record, index));
    if (typeof rowKey === "string") return String((record as Record<string, unknown>)[rowKey]);
    return String(index);
  };

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
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {pagedRows.map((record, localIndex) => {
          const index = paginationEnabled ? (currentPage - 1) * pageSize + localIndex : localIndex;
          return (
            <PlanCard
              key={getKey(record, index)}
              record={record}
              index={index}
              visibleLabelable={visibleLabelable}
              hiddenLabelable={hiddenLabelable}
              unlabelable={unlabelable}
              cellValue={cellValue}
              loading={typeof loading === "boolean" ? loading : undefined}
              rowProps={onRow?.(record, index)}
            />
          );
        })}
      </Space>
      {paginationEnabled && rows.length > pageSize && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <Pagination
            size="small"
            current={currentPage}
            pageSize={pageSize}
            total={rows.length}
            showSizeChanger={paginationConfig.showSizeChanger}
            pageSizeOptions={paginationConfig.pageSizeOptions}
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
  visibleLabelable,
  hiddenLabelable,
  unlabelable,
  cellValue,
  loading,
  rowProps,
}: {
  record: T;
  index: number;
  visibleLabelable: Column<T>[];
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

  return (
    <Card
      size="small"
      loading={loading}
      {...rowProps}
      style={{ ...(rowProps?.onClick ? { cursor: "pointer" } : undefined), ...rowProps?.style }}
    >
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        {visibleLabelable.map((col, ci) => (
          <div key={ci} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: "#8A8C99", flexShrink: 0 }}>{col.title as React.ReactNode}</span>
            <span style={{ textAlign: "right", minWidth: 0 }}>{cellValue(col, record, index)}</span>
          </div>
        ))}
        {unlabelable.map((col, ci) => (
          <div key={`action-${ci}`}>{cellValue(col, record, index)}</div>
        ))}
        {hiddenLabelable.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setPeekOpen((v) => !v)}
              style={{ fontSize: 12, color: "#C97A2B", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              {peekOpen ? "скрыть ▴" : `ещё ${hiddenLabelable.length} ${hiddenLabelable.length === 1 ? "поле" : "поля"} ▾`}
            </button>
            {peekOpen && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed #E2DFD6", display: "flex", flexDirection: "column", gap: 4 }}>
                {hiddenLabelable.map((col, ci) => (
                  <div key={ci} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5 }}>
                    <span style={{ color: "#9799A6", flexShrink: 0 }}>{col.title as React.ReactNode}</span>
                    <span style={{ textAlign: "right", minWidth: 0, color: "#6B6E7D" }}>{cellValue(col, record, index)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Space>
    </Card>
  );
}
