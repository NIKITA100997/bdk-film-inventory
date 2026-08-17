import { apiClient } from "./client";
import { isMobileDevice, printPdfBlob, printHtmlDoc } from "../utils/printLabel";

export type FieldSize = "sm" | "md" | "lg";
export type LabelKind = "unit" | "rack" | "shelf";

export interface LabelFieldConfig {
  key: string;
  size: FieldSize;
  bold: boolean;
}

export interface LabelTemplate {
  width_mm: number;
  height_mm: number;
  fields: LabelFieldConfig[];
}

export interface AvailableField {
  key: string;
  label: string;
  kind: "text" | "image" | "stripe";
  stale_warning: boolean;
}

export const getLabelTemplate = async (kind: LabelKind = "unit"): Promise<LabelTemplate> =>
  (await apiClient.get<LabelTemplate>("/label-template", { params: { kind } })).data;

export const listAvailableLabelFields = async (kind: LabelKind = "unit"): Promise<AvailableField[]> =>
  (await apiClient.get<AvailableField[]>("/label-template/available-fields", { params: { kind } })).data;

export const updateLabelTemplate = async (payload: LabelTemplate, kind: LabelKind = "unit"): Promise<LabelTemplate> =>
  (await apiClient.patch<LabelTemplate>("/label-template", payload, { params: { kind } })).data;

// Настоящий PDF, не HTML (раздел обратной связи по печати на термопринтере
// Codex G500 — прямая печать HTML из браузера ненадёжна: драйвер может
// обрезать нестандартный размер страницы или не напечатать вовсе, тогда как
// печать уже готового PDF-файла — тот же путь, что у "Сохранить как PDF",
// эмпирически подтверждён рабочим). Открываем PDF в новой вкладке и сразу
// вызываем печать после её загрузки — диалог печати открывается сам, без
// лишнего клика по кнопке "Печать" внутри просмотрщика (ждём w.addEventListener
// "load", не вызываем print() синхронно сразу после open — та же гонка,
// что чинили для прежней HTML-версии).
export async function previewLabelTemplate(payload: LabelTemplate, kind: LabelKind = "unit"): Promise<void> {
  const { data } = await apiClient.post("/label-template/preview", payload, { params: { kind }, responseType: "blob" });
  const url = URL.createObjectURL(data as Blob);
  const w = window.open(url, "_blank");
  if (!w) return;
  w.addEventListener("load", () => {
    w.focus();
    w.print();
  });
}

// Раздел про макеты для стеллажей/полок — печать этикеток мест хранения
// (полка рулонного стеллажа, ячейка штрипсового). Тот же двойной
// PDF/HTML путь, что у printLabelsBatch для рулонов (utils/printLabel.ts).
export interface ShelfLabelCell {
  shelf: number;
  cell: number | null;
  location_code: string;
}

export function printShelfLabelsBatch(rackId: number, cells: ShelfLabelCell[]): void {
  if (cells.length === 0) return;
  if (isMobileDevice()) {
    apiClient.post(`/racks/${rackId}/shelf-labels/batch/html`, { cells }, { responseType: "text" }).then(({ data }) => {
      printHtmlDoc(data as string);
    });
  } else {
    apiClient.post(`/racks/${rackId}/shelf-labels/batch`, { cells }, { responseType: "blob" }).then(({ data }) => {
      printPdfBlob(data as Blob);
    });
  }
}

// Бирка на весь стеллаж целиком — отдельный макет (kind="rack") от бирок
// на места хранения выше. Печатается по одной, без списка ячеек.
export function printRackLabel(rackId: number): void {
  if (isMobileDevice()) {
    apiClient.post(`/racks/${rackId}/rack-label/html`, null, { responseType: "text" }).then(({ data }) => {
      printHtmlDoc(data as string);
    });
  } else {
    apiClient.post(`/racks/${rackId}/rack-label`, null, { responseType: "blob" }).then(({ data }) => {
      printPdfBlob(data as Blob);
    });
  }
}
