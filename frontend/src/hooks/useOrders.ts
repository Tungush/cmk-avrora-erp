import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ordersApi } from '../api/orders';

export function useOrders(params?: Record<string, string | number | boolean>) {
  return useQuery({
    queryKey: ['orders', params],
    queryFn: () => ordersApi.list(params).then((res) => res.data),
  });
}

export function useOrder(id: string) {
  return useQuery({
    queryKey: ['order', id],
    queryFn: () => ordersApi.get(id).then((res) => res.data),
    enabled: !!id,
  });
}

export function useCreateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => ordersApi.create(body).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

export function useUpdateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => 
      ordersApi.update(id, body).then(res => res.data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order', variables.id] });
    },
  });
}

export function useTransitionOrderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, toStatus, comment }: { id: string; toStatus: string; comment?: string }) =>
      ordersApi.transitionStatus(id, toStatus, comment).then(res => res.data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order', variables.id] });
    },
  });
}
