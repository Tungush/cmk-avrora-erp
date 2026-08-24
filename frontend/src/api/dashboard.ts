import api from './client';
import type { DashboardSummary, AuditLogEntry, PaginatedResponse } from '../types';
import { mockDashboardSummary, withClientFallback } from './mock';

export interface DirectorDashboard {
  margin: {
    targetPct: number;
    totalPrice: number;
    totalCost: number;
    totalMargin: number;
    actualPct: number | null;
    orders: Array<{
      id: string; orderNumber: string; status: string;
      plannedShipmentDate: string | null; overdueDays: number;
      customer: { name: string };
      totalCost: number | null; totalPrice: number | null;
      margin: number | null; marginPct: number | null;
      marginHealth: 'OK' | 'WARN' | 'CRITICAL' | 'NO_COSTING';
    }>;
  };
  needsDecision: {
    batchOverrides: number;
    priceReviews: number;
    nomenclatureStuck: number;
    quarantineBatches: number;
    expiringReservations: number;
    inboxOrders: number;
  };
  money: { totalContracted: number; totalPaid: number; totalUnpaid: number };
  pipeline: Array<{ status: string; count: number }>;
  overdue: Array<{ id: string; orderNumber: string; overdueDays: number; customer: { name: string } }>;
}

export interface WorkloadForecast {
  requiredHours: number;
  weeklyCapacityHours: number;
  weeksOfBacklog: number | null;
  byStage: Array<{ stage: string; requiredHours: number }>;
  activeOrders: number;
  ordersWithoutPlannedDate: number;
  linesWithoutNorm: number;
  linesTotal: number;
}

export interface CashForecast {
  receivables: { contracted: number; paid: number; owed: number; activeOrders: number; ordersWithoutPaymentData: number };
  payables: { owed: number };
}

export const dashboardApi = {
  getWorkloadForecast: () => api.get<WorkloadForecast>('/dashboards/workload-forecast'),
  getCashForecast: () => api.get<CashForecast>('/dashboards/cash-forecast'),

  getProductionSummary: () =>
    withClientFallback(
      () => api.get<DashboardSummary>('/dashboards/production-summary'),
      { data: mockDashboardSummary } as { data: DashboardSummary },
    ),

  getFinishedGoodsSummary: (params?: Record<string, string>) =>
    api.get<Record<string, unknown>>('/dashboards/finished-goods-summary', { params }),

  // Директорский экран: маржа план/факт, «требует решения», деньги по ДО
  getDirector: () =>
    api.get<DirectorDashboard>('/dashboards/director'),

  getAuditLog: (params?: Record<string, string | number>) =>
    api.get<PaginatedResponse<AuditLogEntry>>('/audit-log', { params }),
};
