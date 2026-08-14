import { Space, Button } from "antd";
import { exportToCsv } from "../utils/csv";
import { printReport } from "../utils/printReport";
import ResponsiveTable from "./ResponsiveTable";
import { useColumnSettings, ColumnSettingsButton, type ColumnOption } from "./ColumnSettings";

export interface ReportColumn<T> {
  key: string;
  header: string;
  render: (record: T) => React.ReactNode;
  printValue: (record: T) => string | number;
  sorter?: (a: T, b: T) => number;
  defaultSortOrder?: "ascend" | "descend";
}

interface Props<T> {
  title: string;
  filename: string;
  rowKey: string | ((record: T) => string);
  columns: ReportColumn<T>[];
  data: T[];
  loading?: boolean;
  /** По умолчанию выводится из filename — свой набор видимых столбцов
   * на сотрудника, тот же механизм и тот же значок, что у ResponsiveTable
   * (components/ColumnSettings.tsx), просто в шапке отчёта, рядом с
   * экспортом — то, что попадает в CSV/печать, определяется тем же
   * выбором, что показан на экране. */
  tableKey?: string;
}

/** Таблица отчёта с настройкой видимых столбцов, экспортом в CSV и печатной
 * формой (5 раздел обратной связи) — состав и печатной формы, и CSV
 * определяется тем же списком, что и видимость столбцов на экране. */
export default function ReportTable<T extends object>({ title, filename, rowKey, columns, data, loading, tableKey }: Props<T>) {
  const columnOptions: ColumnOption[] = columns.map((c) => ({ key: c.key, label: c.header }));
  const settings = useColumnSettings(tableKey ?? filename.replace(/\.csv$/, ""), columnOptions, []);
  const visibleColumns = columns.filter((c) => settings.isVisible(c.key));

  const antdColumns = visibleColumns.map((c) => ({
    title: c.header,
    key: c.key,
    render: (_: unknown, record: T) => c.render(record),
    sorter: c.sorter,
    defaultSortOrder: c.defaultSortOrder,
  }));

  const toPrintRows = () => data.map((r) => Object.fromEntries(visibleColumns.map((c) => [c.key, c.printValue(r)])));

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
        <Space wrap>
          <Button onClick={() => exportToCsv(filename, toPrintRows(), visibleColumns.map((c) => ({ key: c.key, header: c.header })))}>
            Экспорт в Excel
          </Button>
          <Button onClick={() => printReport(title, visibleColumns.map((c) => ({ key: c.key, header: c.header })), toPrintRows())}>
            Печать
          </Button>
        </Space>
        <ColumnSettingsButton columns={columnOptions} settings={settings} />
      </Space>
      <ResponsiveTable<T>
        rowKey={rowKey}
        loading={loading}
        dataSource={data}
        columns={antdColumns}
        pagination={{ pageSize: 20 }}
        scroll={{ x: "max-content" }}
      />
    </Space>
  );
}
