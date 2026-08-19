import api from './client';

export type RoutingStageCode = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';

export interface RoutingStageRow {
  stage: RoutingStageCode;
  label: string;
  exists: boolean;
  workers: number;
  hoursPerUnit: number;
  workCenter: { id: string; code: string; name: string; hourlyRate: number } | null;
  hourlyRate: number;
  manHours: number;
  stageCost: number;
  actualWorkers: number | null;
  actualHours: number | null;
  actualDeviationPct: number | null;
  notes: string | null;
  updatedAt: string | null;
}

export interface RoutingResponse {
  articleId: string;
  rates: { hourlyRate: number; logisticsPct: number; utilitiesPct: number; marginPct: number };
  stages: RoutingStageRow[];
}

export interface CostingExplainLine {
  label: string;
  value: number;
  unit: string;
  source?: string;
  formula?: string;
}

export interface CostingResponse {
  articleId: string;
  result: {
    materialCost: number;
    totalManHours: number;
    laborCost: number;
    logisticsCost: number;
    utilitiesCost: number;
    totalCost: number;
    margin: number;
    price: number;
  };
  explain: {
    lines: CostingExplainLine[];
    totalManHours: number;
    priceCheck: { approvedPrice: number; deviationPct: number; belowCost: boolean } | null;
  };
}

export interface WorkCenter {
  id: string;
  code: string;
  name: string;
  stage: RoutingStageCode;
  hourlyRate: number;
}

export interface CostingImpactLine {
  label: string;
  before: number;
  after: number;
  delta: number;
  deltaPct: number | null;
  unit: '₸' | 'чел/час';
}

export interface CostingPreviewResponse {
  articleId: string;
  current: CostingResponse['result'];
  proposed: CostingResponse['result'];
  impact: CostingImpactLine[];
  affected: {
    ordersCount: number;
    linesCount: number;
    totalQty: number;
    negativeMarginCount: number;
    negativeMarginOrders: Array<{
      orderNumber: string;
      customer: string | null;
      unitPrice: number;
      newCost: number;
    }>;
  };
  approvedPrice: number | null;
  approvedPriceUnchanged: boolean;
}

export interface UsageResponse {
  articleId: string;
  ordersCount: number;
  linesCount: number;
  totalQty: number;
  nearestShipment: { orderNumber: string; date: string | null } | null;
  orders: Array<{
    orderId: string;
    orderNumber: string;
    customer: string | null;
    status: string;
    qty: number;
    plannedShipmentDate: string | null;
  }>;
}

export interface CostingSnapshot {
  id: string;
  calculatedAt: string;
  materialCost: string | number;
  laborCost: string | number;
  totalManHours: string | number;
  totalCost: string | number;
  margin: string | number;
  price: string | number;
  trigger: string | null;
}

export interface PriceReview {
  id: string;
  articleId: string;
  calculatedPrice: string | number;
  approvedPrice: string | number;
  deviationPct: string | number;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  decidedAt: string | null;
  newPrice: string | number | null;
  decisionComment: string | null;
  article: { articleCode: string; name: string; specPrice?: string | number; approvedPrice?: string | number };
}

export interface NormHistoryEntry {
  id: string;
  workers: string | number;
  hoursPerUnit: string | number;
  changedAt: string;
  reason: string | null;
  operation: { stage: RoutingStageCode };
}

export const routingApi = {
  get: (articleId: string) => api.get<RoutingResponse>(`/articles/${articleId}/routing`),
  putNorm: (
    articleId: string,
    stage: RoutingStageCode,
    body: { workers: number; hoursPerUnit: number; workCenterId?: string; notes?: string; reason?: string },
  ) => api.put(`/articles/${articleId}/routing/${stage}`, body),
  postActual: (articleId: string, stage: RoutingStageCode, body: { actualWorkers: number; actualHours: number }) =>
    api.post(`/articles/${articleId}/routing/${stage}/actual`, body),
  promote: (articleId: string, stage: RoutingStageCode) =>
    api.post(`/articles/${articleId}/routing/${stage}/promote`),
  costing: (articleId: string) => api.get<CostingResponse>(`/articles/${articleId}/routing/costing`),
  recalculate: (articleId: string) => api.post(`/articles/${articleId}/routing/recalculate`),
  history: (articleId: string) => api.get<NormHistoryEntry[]>(`/articles/${articleId}/routing/history`),
  workCenters: () => api.get<WorkCenter[]>('/work-centers'),
  previewNorm: (
    articleId: string,
    body: { stage: RoutingStageCode; workers: number; hoursPerUnit: number; workCenterId?: string | null },
  ) => api.post<CostingPreviewResponse>(`/articles/${articleId}/routing/costing/preview`, body),
  usage: (articleId: string) => api.get<UsageResponse>(`/articles/${articleId}/routing/usage`),
  costingHistory: (articleId: string) =>
    api.get<CostingSnapshot[]>(`/articles/${articleId}/routing/costing/history`),
};

/** Пересмотр цены (§3.4): заявка → решение директора */
export const priceReviewsApi = {
  request: (articleId: string, reason?: string) =>
    api.post<PriceReview>(`/articles/${articleId}/price-review`, { reason }),
  list: (params?: Record<string, string | number>) =>
    api.get<{ data: PriceReview[]; meta: { total: number } }>('/price-reviews', { params }),
  approve: (id: string, newPrice: number, comment?: string) =>
    api.post<PriceReview>(`/price-reviews/${id}/approve`, { newPrice, comment }),
  reject: (id: string, comment?: string) =>
    api.post<PriceReview>(`/price-reviews/${id}/reject`, { comment }),
};
