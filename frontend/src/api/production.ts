import { apiClient } from "./client";
import type { AreaValue } from "./units";

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
  line_id: number;
  line_name: string;
  material: string;
  color: string;
  thickness: number;
  qty_per_unit: number;
  part_name: string | null;
}

export interface ProductModelPartCreate {
  line_id: number;
  material: string;
  color: string;
  thickness: number;
  qty_per_unit: number;
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
  line_id: number;
  line_name: string;
  material: string;
  color: string;
  thickness: number;
  quantity_pieces: number;
}

export interface ProductionTask {
  id: number;
  product_model_id: number;
  product_model_name: string;
  product_model_area: AreaValue;
  quantity: number;
  created_by: number;
  created_at: string;
  lines: ProductionTaskLine[];
}

export interface ProductionTaskCreate {
  product_model_id: number;
  quantity: number;
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

export const deleteProductModelPart = async (modelId: number, partId: number): Promise<void> => {
  await apiClient.delete(`/product-models/${modelId}/parts/${partId}`);
};

export const listProductionTasks = async (): Promise<ProductionTask[]> =>
  (await apiClient.get<ProductionTask[]>("/production-tasks")).data;

export const createProductionTask = async (payload: ProductionTaskCreate): Promise<ProductionTask> =>
  (await apiClient.post<ProductionTask>("/production-tasks", payload)).data;
