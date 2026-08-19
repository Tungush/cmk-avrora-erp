import api from './client';
import type { Article, PriceHistory, BomItem, Material, Customer, PaginatedResponse } from '../types';

export const articlesApi = {
  list: (params?: Record<string, string | number | boolean>) =>
    api.get<PaginatedResponse<Article>>('/articles', { params }),
  get: (id: string) => api.get<Article>(`/articles/${id}`),
  create: (body: Record<string, unknown>) => api.post<Article>('/articles', body),
  update: (id: string, body: Record<string, unknown>) => api.patch<Article>(`/articles/${id}`, body),
  getPriceHistory: (id: string) => api.get<PriceHistory[]>(`/articles/${id}/price-history`),
  addPrice: (id: string, body: { price: number; validFrom: string }) =>
    api.post<PriceHistory>(`/articles/${id}/price-history`, body),
  getBom: (id: string) => api.get<BomItem[]>(`/articles/${id}/bom`),
  setBom: (id: string, items: Record<string, unknown>[]) =>
    api.put<{ items: BomItem[] }>(`/articles/${id}/bom`, { items }),
  addBomItem: (id: string, body: { materialId: string; qtyPerUnit: number; operationType?: string }) =>
    api.post<{ item: BomItem }>(`/articles/${id}/bom`, body),
  updateBomItem: (bomItemId: string, body: { qtyPerUnit?: number; operationType?: string }) =>
    api.patch<BomItem>(`/bom-items/${bomItemId}`, body),
  removeBomItem: (bomItemId: string) => api.delete(`/bom-items/${bomItemId}`),
};

/** Заявки на номенклатуру — процесс «как в 1С»: нет артикула → заявка → присвоение */
export interface NomenclatureRequest {
  id: string;
  proposedName: string;
  series: string | null;
  description: string | null;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedBy: string | null;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  article: { articleCode: string; name: string } | null;
}

export const nomenclatureApi = {
  create: (body: { proposedName: string; series?: string; description?: string; reason?: string }) =>
    api.post<NomenclatureRequest>('/nomenclature-requests', body),
  list: (status?: string) =>
    api.get<NomenclatureRequest[]>('/nomenclature-requests', { params: status ? { status } : undefined }),
  approve: (id: string, body?: { articleCode?: string; series?: string; comment?: string }) =>
    api.post<{ request: NomenclatureRequest; article: { id: string; articleCode: string } }>(`/nomenclature-requests/${id}/approve`, body ?? {}),
  reject: (id: string, comment?: string) =>
    api.post<NomenclatureRequest>(`/nomenclature-requests/${id}/reject`, { comment }),
};

export const materialsApi = {
  list: (params?: Record<string, string | number>) =>
    api.get<PaginatedResponse<Material>>('/materials', { params }),
  create: (body: Record<string, unknown>) => api.post<Material>('/materials', body),
  update: (id: string, body: Record<string, unknown>) => api.patch<Material>(`/materials/${id}`, body),
};

export const customersApi = {
  list: (params?: Record<string, string>) =>
    api.get<PaginatedResponse<Customer>>('/customers', { params }),
  create: (body: Record<string, unknown>) => api.post<Customer>('/customers', body),
};
