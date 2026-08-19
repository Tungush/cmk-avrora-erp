import api from './client';
import type { Order, OrderLine, PaginatedResponse, ProductionPlanItem, ProductionStage, MinStockLevel } from '../types';

export const ordersApi = {
  list: (params?: Record<string, string | number | boolean>) =>
    api.get<PaginatedResponse<Order>>('/orders', { params }),

  get: (id: string) =>
    api.get<Order>(`/orders/${id}`),

  create: (body: Record<string, unknown>) =>
    api.post<Order>('/orders', body),

  update: (id: string, body: Record<string, unknown>) =>
    api.patch<Order>(`/orders/${id}`, body),

  transitionStatus: (id: string, toStatus: string, comment?: string) =>
    api.patch<Order>(`/orders/${id}/status`, { status: toStatus, comment }),

  getStages: (id: string) =>
    api.get<ProductionStage[]>(`/orders/${id}/production-stages`),

  updateStage: (orderId: string, stageCode: string, body: Record<string, unknown>) =>
    api.patch<ProductionStage>(`/orders/${orderId}/production-stages/${stageCode}`, body),

  getPayments: (id: string) =>
    api.get<{ prepayment: number; postPayment1: number; postPayment2: number; penalty: number; balanceDue: number }>(`/orders/${id}/payments`),
};

export const productionApi = {
  getPlan: (params?: Record<string, string>) =>
    api.get<{ data: ProductionPlanItem[] }>('/production-plan', { params }),

  recalc: (body?: Record<string, unknown>) =>
    api.post<{ jobId: string }>('/production-plan/recalc', body || {}),

  getJob: (jobId: string) =>
    api.get<{ status: string; result?: unknown }>(`/production-plan/jobs/${jobId}`),

  getMinStockLevels: (params?: Record<string, string | boolean>) =>
    api.get<MinStockLevel[]>('/min-stock-levels', { params }),

  updateMinStock: (articleId: string, body: Record<string, unknown>) =>
    api.patch<MinStockLevel>(`/min-stock-levels/${articleId}`, body),
};
