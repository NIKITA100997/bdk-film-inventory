import { useState } from "react";
import { Space, Select, Button } from "antd";
import { exportToCsv } from "../utils/csv";
import { printReport } from "../utils/printReport";
import ResponsiveTable from "./ResponsiveTable";

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
}

/** Таблица отчёта с выбором видимых столбцов, экспортом в CSV и печатной
 * формой (5 раздел обратной связи) — состав и печатной формы, и CSV
 * определяется тем же списком, что и видимость столбцов на экране. */
export default function ReportTable<T extends object>({ title, filename, rowKey, columns, data, loading }: Props<T>) {
  const [visibleKeys, setVisibleKeys] = useState<string[]>(columns.map((c) => c.key));
  const visibleColumns = columns.filter((c) => visibleKeys.includes(c.key));

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
      <Space wrap>
        <Select
          mode="multiple"
          style={{ minWidth: 280 }}
          placeholder="Столбцы"
          value={visibleKeys}
          onChange={setVisibleKeys}
          maxTagCount={3}
          options={columns.map((c) => ({ value: c.key, label: c.header }))}
        />
        <Button onClick={() => exportToCsv(filename, toPrintRows(), visibleColumns.map((c) => ({ key: c.key, header: c.header })))}>
          Экспорт в Excel
        </Button>
        <Button onClick={() => printReport(title, visibleColumns.map((c) => ({ key: c.key, header: c.header })), toPrintRows())}>
          Печать
        </Button>
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
