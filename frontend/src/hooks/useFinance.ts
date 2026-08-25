import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { financeApi } from '../api/finance';

export function usePaymentDocs(params?: Record<string, string | number>) {
  return useQuery({
    queryKey: ['payment-docs', params],
    queryFn: () => financeApi.getPaymentDocs(params).then((res) => res.data),
  });
}

export function usePaymentDoc(id: string | null) {
  return useQuery({
    queryKey: ['payment-doc', id],
    queryFn: () => financeApi.getPaymentDoc(id as string).then((res) => res.data),
    enabled: Boolean(id),
  });
}

export function useReceivables(params?: Record<string, string | boolean>) {
  return useQuery({
    queryKey: ['receivables', params],
    queryFn: () => financeApi.getReceivables(params).then((res) => res.data),
  });
}

export function useAddPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, body }: { docId: string; body: { amount: number; paidAt?: string } }) =>
      financeApi.addPayment(docId, body).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-docs'] });
      queryClient.invalidateQueries({ queryKey: ['receivables'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}
