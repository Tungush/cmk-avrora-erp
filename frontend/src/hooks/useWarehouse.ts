import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { warehouseApi } from '../api/warehouse';

export function useMaterialBalance(params?: Record<string, string>) {
  return useQuery({
    queryKey: ['material-balance', params],
    queryFn: () => warehouseApi.getMaterialBalance(params).then((res) => res.data),
  });
}

export function usePostMaterialMovement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => warehouseApi.postMaterialMovement(body).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['material-balance'] });
    },
  });
}

export function usePostFGMovement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => warehouseApi.postFGMovement(body).then(res => res.data),
    onSuccess: () => {
      // Invalidate relevant queries (orders, maybe dashboard)
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}


/** Журнал приходов материалов — «за сколько что купили» */
export function useReceipts(params?: Record<string, string | number>) {
  return useQuery({
    queryKey: ['receipts', params],
    queryFn: () => warehouseApi.getReceipts(params).then((r) => r.data),
  });
}

/** История закупок конкретного материала */
export function useMaterialMovements(materialId: string | null) {
  return useQuery({
    queryKey: ['material-movements', materialId],
    enabled: !!materialId,
    queryFn: () => warehouseApi.getMaterialMovements(materialId!).then((r) => r.data),
  });
}

/** Приход: остаток + учётная цена + каскадный пересчёт изделий */
export function usePostReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      materialId: string; qty: number; unitPrice: number;
      movementDate?: string; supplierName?: string; documentNumber?: string; comment?: string;
    }) => warehouseApi.postReceipt(body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['materials'] });
      qc.invalidateQueries({ queryKey: ['material-balance'] });
      qc.invalidateQueries({ queryKey: ['material-movements'] });
      qc.invalidateQueries({ queryKey: ['bom'] });
      qc.invalidateQueries({ queryKey: ['routing-costing'] });
    },
  });
}
