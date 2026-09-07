import { message } from "antd";
import { apiClient } from "./client";
import { isMobileDevice, isVerticalPrint, printPdfBlob, printHtmlDoc, printErrorMessage } from "../utils/printLabel";

// Раздел про QR-этикетки п/ф (партия/стеллаж/полка) — тот же двойной
// PDF/HTML путь печати, что у этикеток плёнки (api/units.ts, api/labels.ts),
// плюс новый выбор формата страницы: обычная наклейка или лист А4 (для
// крупных объектов — поддон, стеллаж целиком, крупная партия, где
// маленькая наклейка нечитаема). page_format — параметр самого запроса
// на печать, не сохранённая настройка устройства (в отличие от vertical).
export type PageFormat = "sticker" | "a4";

export interface PrintPartLabelOptions {
  pageFormat?: PageFormat;
}

const PRINT_MESSAGE_KEY = "print-part-label";

export function printPartUnitLabel(unitId: number, options?: PrintPartLabelOptions): void {
  message.loading({ content: "Готовим этикетку к печати…", key: PRINT_MESSAGE_KEY, duration: 0 });
  const params = { vertical: isVerticalPrint(), page_format: options?.pageFormat ?? "sticker" };
  const request = isMobileDevice()
    ? apiClient.get(`/part-labels/${unitId}/html`, { params, responseType: "text" }).then(({ data }) => printHtmlDoc(data as string))
    : apiClient.get(`/part-labels/${unitId}`, { params, responseType: "blob" }).then(({ data }) => printPdfBlob(data as Blob));
  request
    .then(() => message.success({ content: "Отправлено на печать", key: PRINT_MESSAGE_KEY }))
    .catch((e) => message.error({ content: printErrorMessage(e), key: PRINT_MESSAGE_KEY }));
}

export function printPartUnitLabelsBatch(unitIds: number[], options?: PrintPartLabelOptions): void {
  if (unitIds.length === 0) return;
  message.loading({ content: "Готовим этикетки к печати…", key: PRINT_MESSAGE_KEY, duration: 0 });
  const params = { vertical: isVerticalPrint(), page_format: options?.pageFormat ?? "sticker" };
  const request = isMobileDevice()
    ? apiClient
        .post("/part-labels/batch/html", { unit_ids: unitIds }, { params, responseType: "text" })
        .then(({ data }) => printHtmlDoc(data as string))
    : apiClient
        .post("/part-labels/batch", { unit_ids: unitIds }, { params, responseType: "blob" })
        .then(({ data }) => printPdfBlob(data as Blob));
  request
    .then(() => message.success({ content: "Отправлено на печать", key: PRINT_MESSAGE_KEY }))
    .catch((e) => message.error({ content: printErrorMessage(e), key: PRINT_MESSAGE_KEY }));
}

export function printPartRackLabel(rackId: number, options?: PrintPartLabelOptions): void {
  message.loading({ content: "Готовим этикетку к печати…", key: PRINT_MESSAGE_KEY, duration: 0 });
  const params = { vertical: isVerticalPrint(), page_format: options?.pageFormat ?? "sticker" };
  const request = isMobileDevice()
    ? apiClient.post(`/part-racks/${rackId}/rack-label/html`, null, { params, responseType: "text" }).then(({ data }) => printHtmlDoc(data as string))
    : apiClient.post(`/part-racks/${rackId}/rack-label`, null, { params, responseType: "blob" }).then(({ data }) => printPdfBlob(data as Blob));
  request
    .then(() => message.success({ content: "Отправлено на печать", key: PRINT_MESSAGE_KEY }))
    .catch((e) => message.error({ content: printErrorMessage(e), key: PRINT_MESSAGE_KEY }));
}

export interface PartShelfLabelCell {
  shelf: number;
  location_code: string;
}

export function printPartShelfLabelsBatch(rackId: number, cells: PartShelfLabelCell[], options?: PrintPartLabelOptions): void {
  if (cells.length === 0) return;
  message.loading({ content: "Готовим этикетки к печати…", key: PRINT_MESSAGE_KEY, duration: 0 });
  const params = { vertical: isVerticalPrint(), page_format: options?.pageFormat ?? "sticker" };
  const request = isMobileDevice()
    ? apiClient
        .post(`/part-racks/${rackId}/shelf-labels/batch/html`, { cells }, { params, responseType: "text" })
        .then(({ data }) => printHtmlDoc(data as string))
    : apiClient
        .post(`/part-racks/${rackId}/shelf-labels/batch`, { cells }, { params, responseType: "blob" })
        .then(({ data }) => printPdfBlob(data as Blob));
  request
    .then(() => message.success({ content: "Отправлено на печать", key: PRINT_MESSAGE_KEY }))
    .catch((e) => message.error({ content: printErrorMessage(e), key: PRINT_MESSAGE_KEY }));
}
