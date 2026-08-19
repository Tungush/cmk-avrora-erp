import api from './client';
import type { DashboardSummary, AuditLogEntry, PaginatedResponse } from '../types';
import { mockDashboardSummary, withClientFallback } from './mock';

export const dashboardApi = {
  getProductionSummary: () =>
    withClientFallback(
      () => api.get<DashboardSummary>('/dashboards/production-summary'),
      { data: mockDashboardSummary } as { data: DashboardSummary },
    ),

  getFinishedGoodsSummary: (params?: Record<string, string>) =>
    api.get<Record<string, unknown>>('/dashboards/finished-goods-summary', { params }),

  getAuditLog: (params?: Record<string, string | number>) =>
    api.get<PaginatedResponse<AuditLogEntry>>('/audit-log', { params }),
};
