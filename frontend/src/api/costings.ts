import api from './client';

export interface CostingVersionSummary {
  id: string;
  version: number;
  status: 'DRAFT' | 'APPROVED' | 'ARCHIVED';
  calculatedAt: string;
  approvedAt: string | null;
  totalCost: number;
  price: number;
  marginPct: number;
  hasShortage: boolean;
  hasMissingNorm: boolean;
  hasMissingBom: boolean;
  materialsCount: number;
}

export interface CostingMaterialRow {
  id: string;
  materialCode: string | null;
  materialName: string;
  qtyTotal: number;
  unitPrice: number;
  lineCost: number;
  priceState: 'ESTIMATE' | 'ORDERED' | 'ACTUAL';
  supplierOrderNumber: string | null;
  priceStateChangedAt: string | null;
  isShortage: boolean;
  batch: { id: string; receiptDate: string; documentNumber: string | null; supplierName: string | null; batchType: 'OWN' | 'TOLLING' } | null;
}

export interface CostingLaborRow {
  id: string;
  stage: string;
  laborKind: 'STAFF' | 'CONTRACTOR';
  contractor: { id: string; name: string } | null;
  share: number;
  rateType: string;
  rate: number;
  manHours: number;
  lineCost: number;
}

export interface CostingDetail {
  id: string;
  version: number;
  status: string;
  calculatedAt: string;
  approvedAt: string | null;
  materialCost: number;
  laborCost: number;
  contractorCost: number;
  logisticsCost: number;
  utilitiesCost: number;
  totalCost: number;
  margin: number;
  price: number;
  marginPct: number;
  hasShortage: boolean;
  hasMissingNorm: boolean;
  hasMissingBom: boolean;
  materials: CostingMaterialRow[];
  labor: CostingLaborRow[];
}

export interface CostingConfig {
  hourlyRate: number;
  logisticsPct: number;
  utilitiesPct: number;
  vatPct: number;
  marginPct: number;
  paymentTermDays: number;
}

export const costingConfigApi = {
  /** Действующие коэффициенты калькуляции — читать может любой вошедший */
  get: () => api.get<CostingConfig>('/costing-config'),
  /** Новая версия — старая закрывается по дате, история коэффициентов не теряется (admin) */
  update: (body: CostingConfig) => api.put<CostingConfig>('/costing-config', body),
};

export const costingsApi = {
  list: (orderLineId: string) =>
    api.get<{ data: CostingVersionSummary[]; total: number }>(`/order-lines/${orderLineId}/costings`),

  /** Посчитать новую версию: материалы по партиям, труд по нормам и подряду */
  build: (orderLineId: string, body: Record<string, unknown> = {}) =>
    api.post<CostingDetail>(`/order-lines/${orderLineId}/costings`, body),

  /** Согласовать версию — прежняя уходит в архив */
  approve: (orderLineId: string, costingId: string) =>
    api.post(`/order-lines/${orderLineId}/costings/${costingId}/approve`, {}),

  get: (orderLineId: string, costingId: string) =>
    api.get<CostingDetail>(`/order-lines/${orderLineId}/costings/${costingId}`),

  compare: (orderLineId: string, baseId: string, targetId: string) =>
    api.get(`/order-lines/${orderLineId}/costings/compare/${baseId}/${targetId}`),
};
