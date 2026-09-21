import * as XLSX from "xlsx";

/** Экспорт таблицы в настоящий .xlsx (раздел про "выгрузку в обычный Excel
 * формат" — раньше был CSV с BOM, открывался в Excel, но не был реальной
 * книгой/листом: без типов ячеек, без нескольких листов, некоторые версии
 * Excel просили подтвердить формат при открытии). SheetJS (`xlsx`) пишет
 * файл сам, включая скачивание в браузере — без ручного Blob/URL, как
 * было в CSV-варианте. */
export function exportToExcel<T>(filename: string, rows: T[], columns: { key: keyof T; header: string }[]) {
  const header = columns.map((c) => c.header);
  const data = rows.map((r) => columns.map((c) => r[c.key] ?? ""));
  const sheet = XLSX.utils.aoa_to_sheet([header, ...data]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Данные");
  const xlsxName = filename.replace(/\.(csv|xlsx)$/i, "") + ".xlsx";
  XLSX.writeFile(book, xlsxName);
}
