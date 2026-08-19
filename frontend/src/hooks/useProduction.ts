import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { productionApi } from '../api/orders'; // productionApi is exported from api/orders.ts

export function useProductionPlan(params?: Record<string, string>) {
  return useQuery({
    queryKey: ['production-plan', params],
    queryFn: () => productionApi.getPlan(params).then((res) => res.data),
  });
}

export function useRecalcPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: Record<string, unknown>) => productionApi.recalc(body).then(res => res.data),
    onSuccess: () => {
      // In a real app we'd poll the job status, for MVP we just invalidate
      queryClient.invalidateQueries({ queryKey: ['production-plan'] });
    },
  });
}

export function useMinStockLevels(params?: Record<string, string | boolean>) {
  return useQuery({
    queryKey: ['min-stock-levels', params],
    queryFn: () => productionApi.getMinStockLevels(params).then((res) => res.data),
  });
}

export function useUpdateMinStock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ articleId, body }: { articleId: string; body: Record<string, unknown> }) =>
      productionApi.updateMinStock(articleId, body).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['min-stock-levels'] });
      queryClient.invalidateQueries({ queryKey: ['production-plan'] });
    },
  });
}
