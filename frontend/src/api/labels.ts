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

export async function previewLabelTemplate(payload: LabelTemplate): Promise<void> {
  const { data } = await apiClient.post<string>("/label-template/preview", payload, { responseType: "text" });
  const w = window.open("", "_blank", "width=400,height=600");
  if (!w) return;
  w.document.open();
  w.document.write(data);
  w.document.close();
}
