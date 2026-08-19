import type { DashboardSummary } from '../types';

export const mockDashboardSummary: DashboardSummary = {
  productionPlanFact: { planned: 210, actual: 205 },
  workshopLoadHours: { used: 1480, total: 1600 },
  receivablesTotal: 1900000,
  fgStockVsNorm: { inStock: 82, norm: 100 },
};

export function withClientFallback<T>(request: () => Promise<T>, fallback: T): Promise<T> {
  return request().catch(() => fallback);
}
