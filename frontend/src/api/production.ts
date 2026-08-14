import { apiClient } from "./client";
import type { AreaValue, WriteOffReasonValue } from "./units";

export interface ProductionLine {
  id: number;
  name: string;
  area: AreaValue;
  is_active: boolean;
}

export interface ProductionLineCreate {
  name: string;
  area: AreaValue;
}

export interface ProductionLineUpdate {
  name?: string;
  area?: AreaValue;
  is_active?: boolean;
}

export interface ProductModelPart {
  id: number;
  area: AreaValue;
  qty_per_unit: number;
  width_mm: number;
  length_m: number;
  strip_width_mm: number | null;
  part_name: string | null;
}

export interface ProductModelPartCreate {
  area: AreaValue;
  qty_per_unit: number;
  width_mm: number;
  length_m: number;
  strip_width_mm?: number;
  part_name?: string;
}

export interface ProductModel {
  id: number;
  name: string;
  area: AreaValue;
  is_active: boolean;
  parts: ProductModelPart[];
}

export interface ProductModelCreate {
  name: string;
  area: AreaValue;
}

export interface ProductModelUpdate {
  name?: string;
  is_active?: boolean;
}

export interface ProductionTaskLine {
  id: number;
  line_id: number | null;
  line_name: string;
  material: string;
  color: string;
  thickness: number;
  quantity_pieces: number;
  width_mm: number;
  length_m: number;
  strip_width_mm: number | null;
  part_name: string | null;
  produced_good_pieces: number;
  defect_pieces: number;
  remaining_pieces: number;
  remaining_length_m: number;
  assigned_pieces: number;
  unassigned_pieces: number;
  assignments: ProductionTaskLineAssignment[];
  issued_length_m: number;
}

export interface ProductionTask {
  id: number;
  product_model_id: number | null;
  product_model_name: string | null;
  name: string | null;
  area: AreaValue;
  quantity: number | null;
  created_by: number;
  created_at: string;
  lines: ProductionTaskLine[];
}

export interface ProductionTaskLineManualCreate {
  line_id?: number;
  material: string;
  color: string;
  thickness: number;
  quantity_pieces: number;
  width_mm: number;
  length_m: number;
  strip_width_mm?: number;
  part_name?: string;
}

export interface ProductionTaskManualCreate {
  name: string;
  area: AreaValue;
  product_model_id?: number;
  quantity?: number;
  lines: ProductionTaskLineManualCreate[];
}

export interface ProductionTaskLineReport {
  id: number;
  assignment_id: number | null;
  good_pieces: number;
  defect_pieces: number;
  defect_reason: WriteOffReasonValue | null;
  note: string | null;
  reported_by: number;
  reported_at: string;
}

export interface ProductionTaskLineReportCreate {
  assignment_id: number;
  good_pieces: number;
  defect_pieces: number;
  defect_reason?: WriteOffReasonValue;
  note?: string;
}

export const listProductionLines = async (): Promise<ProductionLine[]> =>
  (await apiClient.get<ProductionLine[]>("/production-lines")).data;

export const createProductionLine = async (payload: ProductionLineCreate): Promise<ProductionLine> =>
  (await apiClient.post<ProductionLine>("/production-lines", payload)).data;

export const updateProductionLine = async (lineId: number, payload: ProductionLineUpdate): Promise<ProductionLine> =>
  (await apiClient.patch<ProductionLine>(`/production-lines/${lineId}`, payload)).data;

export const listProductModels = async (): Promise<ProductModel[]> =>
  (await apiClient.get<ProductModel[]>("/product-models")).data;

export const getProductModel = async (modelId: number): Promise<ProductModel> =>
  (await apiClient.get<ProductModel>(`/product-models/${modelId}`)).data;

export const createProductModel = async (payload: ProductModelCreate): Promise<ProductModel> =>
  (await apiClient.post<ProductModel>("/product-models", payload)).data;

export const updateProductModel = async (modelId: number, payload: ProductModelUpdate): Promise<ProductModel> =>
  (await apiClient.patch<ProductModel>(`/product-models/${modelId}`, payload)).data;

export const addProductModelPart = async (modelId: number, payload: ProductModelPartCreate): Promise<ProductModelPart> =>
  (await apiClient.post<ProductModelPart>(`/product-models/${modelId}/parts`, payload)).data;

export const updateProductModelPart = async (
  modelId: number,
  partId: number,
  payload: ProductModelPartCreate,
): Promise<ProductModelPart> =>
  (await apiClient.put<ProductModelPart>(`/product-models/${modelId}/parts/${partId}`, payload)).data;

export const deleteProductModelPart = async (modelId: number, partId: number): Promise<void> => {
  await apiClient.delete(`/product-models/${modelId}/parts/${partId}`);
};

export const listProductionTasks = async (): Promise<ProductionTask[]> =>
  (await apiClient.get<ProductionTask[]>("/production-tasks")).data;

export const createProductionTaskManual = async (payload: ProductionTaskManualCreate): Promise<ProductionTask> =>
  (await apiClient.post<ProductionTask>("/production-tasks/manual", payload)).data;

export const listTaskLineReports = async (taskId: number, lineId: number): Promise<ProductionTaskLineReport[]> =>
  (await apiClient.get<ProductionTaskLineReport[]>(`/production-tasks/${taskId}/lines/${lineId}/reports`)).data;

export const createTaskLineReport = async (
  taskId: number,
  lineId: number,
  payload: ProductionTaskLineReportCreate,
): Promise<ProductionTaskLineReport> =>
  (await apiClient.post<ProductionTaskLineReport>(`/production-tasks/${taskId}/lines/${lineId}/reports`, payload)).data;

export interface ProductionTaskLineAssignment {
  id: number;
  line_id: number;
  line_name: string;
  date: string;
  employee_names: string;
  quantity_pieces: number;
  created_by: number;
  created_at: string;
  produced_good_pieces: number;
  defect_pieces: number;
}

export interface ProductionTaskLineAssignmentCreate {
  line_id: number;
  date: string;
  employee_names: string;
  quantity_pieces: number;
}

export const listTaskLineAssignments = async (
  taskId: number,
  lineId: number,
): Promise<ProductionTaskLineAssignment[]> =>
  (await apiClient.get<ProductionTaskLineAssignment[]>(`/production-tasks/${taskId}/lines/${lineId}/assignments`)).data;

export const createTaskLineAssignment = async (
  taskId: number,
  lineId: number,
  payload: ProductionTaskLineAssignmentCreate,
): Promise<ProductionTaskLineAssignment> =>
  (
    await apiClient.post<ProductionTaskLineAssignment>(
      `/production-tasks/${taskId}/lines/${lineId}/assignments`,
      payload,
    )
  ).data;

export const deleteProductionTask = async (taskId: number): Promise<void> => {
  await apiClient.delete(`/production-tasks/${taskId}`);
};

export const deleteProductModel = async (modelId: number): Promise<void> => {
  await apiClient.delete(`/product-models/${modelId}`);
};
