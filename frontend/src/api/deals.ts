import api from './client';

export interface Deal {
  id: string;
  source: string;
  customerId: string;
  articleId: string | null;
  qtyOrdered: number;
  qtyShipped: number;
  amountOrdered: number;
  amountPaid: number;
  status: string;
  shipmentDate: string | null;
  siteCode: string | null;
  region: string | null;
  managerName: string | null;
  plannedDispatchMonth: string | null;
  hasFormalRequest: boolean;
  customer: { id: string; name: string };
  article: { id: string; name: string; articleCode: string } | null;
}

export interface DealInput {
  customerId?: string;
  customerName?: string;
  articleId?: string;
  articleName?: string;
  qtyOrdered: number;
  amountOrdered: number;
  siteCode?: string;
  region?: string;
  managerName?: string;
  plannedDispatchMonth?: string;
  hasFormalRequest?: boolean;
  source?: string;
}

export const dealsApi = {
  list: () => api.get<Deal[]>('/deals'),
  create: (input: DealInput) => api.post<Deal>('/deals', input),
  update: (id: string, input: Partial<DealInput>) => api.patch<Deal>(`/deals/${id}`, input),
  remove: (id: string) => api.delete(`/deals/${id}`),
};
