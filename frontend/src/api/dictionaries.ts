import { apiClient } from "./client";
import type { MaterialSku } from "./units";

export const listMaterialSkus = async (): Promise<MaterialSku[]> =>
  (await apiClient.get<MaterialSku[]>("/material-skus")).data;
