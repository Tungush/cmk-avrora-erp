import api from './client';
import type { PaymentDocument, Payment, AcceptanceAct, ReceivableSummary, PaginatedResponse } from '../types';

export const financeApi = {
  getPaymentDocs: (params?: Record<string, string | number>) =>
    api.get<PaginatedResponse<PaymentDocument>>('/payment-documents', { params }),

  getPaymentDoc: (id: string) =>
    api.get<PaymentDocument>(`/payment-documents/${id}`),

  createPaymentDoc: (body: Record<string, unknown>) =>
    api.post<PaymentDocument>('/payment-documents', body),

  addPayment: (docId: string, body: { amount: number; paidAt?: string }) =>
    api.post<Payment>(`/payment-documents/${docId}/payments`, body),

  getReceivables: (params?: Record<string, string | boolean>) =>
    api.get<ReceivableSummary[]>('/payment-documents/receivables', { params }),

  createAcceptanceAct: (body: Record<string, unknown>) =>
    api.post<AcceptanceAct>('/acceptance-acts', body),
};
