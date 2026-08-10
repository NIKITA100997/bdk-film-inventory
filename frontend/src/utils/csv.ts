/** Экспорт таблицы в CSV (9.6 раздел бэклога доработок) — без библиотеки,
 * разделитель ";" и BOM для корректного открытия в Excel с русской
 * локалью и кириллицей. */
export function exportToCsv<T>(filename: string, rows: T[], columns: { key: keyof T; header: string }[]) {
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.header)).join(";");
  const lines = rows.map((r) => columns.map((c) => escape(r[c.key])).join(";"));
  const BOM = String.fromCharCode(0xfeff);
  const csv = BOM + [header, ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
