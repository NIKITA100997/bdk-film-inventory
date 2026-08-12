import { apiClient } from "./client";

export type FieldSize = "sm" | "md" | "lg";

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

export const getLabelTemplate = async (): Promise<LabelTemplate> =>
  (await apiClient.get<LabelTemplate>("/label-template")).data;

export const listAvailableLabelFields = async (): Promise<AvailableField[]> =>
  (await apiClient.get<AvailableField[]>("/label-template/available-fields")).data;

export const updateLabelTemplate = async (payload: LabelTemplate): Promise<LabelTemplate> =>
  (await apiClient.patch<LabelTemplate>("/label-template", payload)).data;

// Настоящий PDF, не HTML (раздел обратной связи по печати на термопринтере
// Codex G500 — прямая печать HTML из браузера ненадёжна: драйвер может
// обрезать нестандартный размер страницы или не напечатать вовсе, тогда как
// печать уже готового PDF-файла — тот же путь, что у "Сохранить как PDF",
// эмпирически подтверждён рабочим). Открываем PDF в новой вкладке и сразу
// вызываем печать после её загрузки — диалог печати открывается сам, без
// лишнего клика по кнопке "Печать" внутри просмотрщика (ждём w.addEventListener
// "load", не вызываем print() синхронно сразу после open — та же гонка,
// что чинили для прежней HTML-версии).
export async function previewLabelTemplate(payload: LabelTemplate): Promise<void> {
  const { data } = await apiClient.post("/label-template/preview", payload, { responseType: "blob" });
  const url = URL.createObjectURL(data as Blob);
  const w = window.open(url, "_blank");
  if (!w) return;
  w.addEventListener("load", () => {
    w.focus();
    w.print();
  });
}
