import api from './client';

export interface PurchaseCut {
  key: string | null;
  docs: number;
  total: number;
  telecom: number;
  other: number;
}

export interface PurchasesDashboard {
  kpi: {
    owed: { amount: number; docs: number; totalDocs: number; otherCurrencies: Array<{ currency: string; amount: number }> };
    overdue30: { amount: number; docs: number; over90: number; over90Amount: number };
    spendMonth: { amount: number; docs: number; prevAmount: number };
    noReceipt: { docs: number; totalDocs: number; paidDocs: number; paidAmount: number };
  };
  totalKzt: number;
  dimensions: Record<string, PurchaseCut[]>;
  buckets: Array<{ label: string; docs: number; amount: number }>;
  unpaidDocs: Array<{
    id: string; doNumber: string; doDate: string | null; ageDays: number;
    supplier: string; supplierId: string; currency: string;
    totalAmount: number; paidAmount: number; unpaidAmount: number;
  }>;
  suppliers: Array<{
    id: string; name: string; docs: number; total: number; paid: number;
    unpaid: number; noReceipt: number; lastDate: string | null;
  }>;
  supplierStats: { total: number; top5Share: number; top10Share: number; oneOff: number };
  control: Array<{ code: string; label: string; docs: number; amount: number }>;
}

export interface PurchaseDoc {
  id: string; doNumber: string; doDate: string | null; status: string;
  supplier: string; supplierId: string; currency: string;
  totalAmount: number; paidAmount: number; unpaidAmount: number;
  businessDirection: string | null; projectName: string | null;
  costCategory: string | null; warehouseName: string | null;
  linesCount: number; batchesCount: number;
}

export const purchasesApi = {
  dashboard: () => api.get<PurchasesDashboard>('/purchases/dashboard'),
  documents: (params?: Record<string, string | number>) =>
    api.get<{ data: PurchaseDoc[]; meta: { page: number; pageSize: number; total: number } }>(
      '/purchases/documents', { params },
    ),
};
