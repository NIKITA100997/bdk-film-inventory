import { Table, Card, Space, Empty } from "antd";
import type { TableProps } from "antd";
import { Grid } from "antd";

type Column<T> = NonNullable<TableProps<T>["columns"]>[number];

/** Обёртка над antd Table (раздел про адаптацию под планшет) — на узких
 * экранах таблицы с большим числом колонок листались влево/вправо, что
 * оказалось хуже, чем сама теснота: на широких экранах рендерит обычный
 * Table без изменений, на узких — по тем же columns (title+render, как
 * они уже везде написаны в проекте) собирает карточку на строку: подпись
 * колонки слева, значение справа, друг под другом. Колонки без title
 * (обычно последняя, с кнопками действий) идут внизу карточки без
 * подписи. Тот же набор пропсов, что у Table — замена только импорта и
 * тега, columns переписывать не нужно. */
export default function ResponsiveTable<T extends object>({
  columns,
  dataSource,
  rowKey,
  cardBreakpoint = "md",
  locale,
  loading,
  ...rest
}: TableProps<T> & { cardBreakpoint?: "xs" | "sm" | "md" | "lg" }) {
  const screens = Grid.useBreakpoint();
  const wide = screens[cardBreakpoint] ?? true;

  if (wide || !columns) {
    return <Table<T> columns={columns} dataSource={dataSource} rowKey={rowKey} locale={locale} loading={loading} {...rest} />;
  }

  const cols = columns as Column<T>[];
  const labelCols = cols.filter((c) => c.title);
  const actionCols = cols.filter((c) => !c.title);
  const rows = dataSource ?? [];

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
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={(locale as { emptyText?: string })?.emptyText ?? "Нет данных"} />;
  }

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      {rows.map((record, index) => (
        <Card key={getKey(record, index)} size="small" loading={typeof loading === "boolean" ? loading : undefined}>
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            {labelCols.map((col, ci) => (
              <div key={ci} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ color: "#8A8C99", flexShrink: 0 }}>{col.title as React.ReactNode}</span>
                <span style={{ textAlign: "right", minWidth: 0 }}>{cellValue(col, record, index)}</span>
              </div>
            ))}
            {actionCols.map((col, ci) => (
              <div key={`action-${ci}`}>{cellValue(col, record, index)}</div>
            ))}
          </Space>
        </Card>
      ))}
    </Space>
  );
}
