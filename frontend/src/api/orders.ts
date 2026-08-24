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

  // Инбокс «Новые заказы» из 1С: блокеры + явный приём в производство
  inbox: () =>
    api.get<{ data: Array<Order & { blockers: Array<{ code: string; message: string }>; canAccept: boolean }>; meta: { total: number } }>('/orders/inbox'),

  accept: (id: string, comment?: string) =>
    api.post<{ order: Order }>(`/orders/${id}/accept`, { comment }),

  // Подряд по заказу и сверка с актами 1С
  contractorWork: (orderId: string) =>
    api.get<{
      data: Array<{
        id: string; routingStage: string; contractorId: string; share: number;
        rateType: string; rate: number; actualQty: number | null; amount: number;
        isAccepted: boolean; contractor?: { id: string; name: string };
      }>;
      reconciliation: Array<{ contractorId: string; name: string; logged: number; acted: number; delta: number; status: string }>;
    }>(`/orders/${orderId}/contractor-work`),

  /** Отдать передел подрядчику — вызывается прямо из отметки этапа */
  assignContractor: (orderId: string, stage: string, body: {
    contractorId: string; share?: number; rateType?: string; rate?: number;
    workLocation?: 'OUR_SHOP' | 'CONTRACTOR_SITE'; plannedHours?: number; reason?: string;
  }) => api.post(`/orders/${orderId}/stages/${stage}/contractor`, body),

  /** Принять работу подрядчика: замораживает сумму */
  acceptContractorWork: (workId: string, body: { actualQty: number; actualWorkers?: number; actualAmount?: number }) =>
    api.patch(`/contractor-work/${workId}/accept`, body),

  removeContractorWork: (workId: string) =>
    api.delete(`/contractor-work/${workId}`),

  contractors: () =>
    api.get<Array<{ id: string; name: string; defaultRateType: string; defaultRate: number; defaultWorkLocation: string }>>('/contractors'),

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
