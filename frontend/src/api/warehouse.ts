import api from './client';
import type { MaterialStockMovement, FinishedGoodsMovement, MaterialBalance, PurchaseRequest, PaginatedResponse } from '../types';

export const warehouseApi = {
  postMaterialMovement: (body: Record<string, unknown>) =>
    api.post<MaterialStockMovement>('/warehouse/materials/movements', body),

  getMaterialBalance: (params?: Record<string, string>) =>
    api.get<MaterialBalance[]>('/warehouse/materials/balance', { params }),

  postFGMovement: (body: Record<string, unknown>) =>
    api.post<FinishedGoodsMovement>('/warehouse/finished-goods/movements', body),

  getPurchaseRequests: (params?: Record<string, string | number>) =>
    api.get<PaginatedResponse<PurchaseRequest>>('/purchase-requests', { params }),

  approvePurchaseRequest: (id: string) =>
    api.post<PurchaseRequest>(`/purchase-requests/${id}/approve`),

  /** Приход материала: занести закуп — обновит цену и пересчитает себестоимость */
  postReceipt: (body: {
    materialId: string; qty: number; unitPrice: number;
    movementDate?: string; supplierName?: string; documentNumber?: string; comment?: string;
  }) => api.post<ReceiptResponse>('/warehouse/materials/receipt', body),

  getReceipts: (params?: Record<string, string | number>) =>
    api.get<{ data: Receipt[]; meta: { page: number; pageSize: number; total: number } }>('/warehouse/receipts', { params }),

  getMaterialMovements: (materialId: string) =>
    api.get<Receipt[]>(`/warehouse/materials/${materialId}/movements`),
};

export interface Receipt {
  id: string;
  itemId?: string;
  movementType?: string;
  qty: string | number;
  unitPrice: string | number;
  movementDate: string;
  supplierName: string | null;
  documentNumber: string | null;
  comment: string | null;
  origin?: 'MOVEMENT' | 'LOCAL' | 'ONEC' | 'INVENTORY';
  priceAnomaly?: boolean;
  material?: { materialCode: string; name: string; unit: string; category: string };
}

export interface ReceiptResponse {
  movement: Receipt;
  material: { id: string; materialCode: string; name: string; unit: string; stockQty: number };
  price: { before: number; after: number; receipt: number; changed: boolean };
  affectedArticles: number;
  recalculation: { jobId: string; status: string } | null;
}
