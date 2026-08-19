import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customersApi, articlesApi, materialsApi, nomenclatureApi } from '../api/catalog';

export function useCustomers(params?: Record<string, string>) {
  return useQuery({
    queryKey: ['customers', params],
    queryFn: () => customersApi.list(params).then((res) => res.data),
  });
}

export function useArticles(params?: Record<string, string | number | boolean>) {
  return useQuery({
    queryKey: ['articles', params],
    queryFn: () => articlesApi.list(params).then((res) => res.data),
  });
}

export function useMaterials(params?: Record<string, string | number>) {
  return useQuery({
    queryKey: ['materials', params],
    queryFn: () => materialsApi.list(params).then((res) => res.data),
  });
}


/** Состав изделия (BOM) — из чего собирается ГП */
export function useBom(articleId: string | null) {
  return useQuery({
    queryKey: ['bom', articleId],
    enabled: !!articleId,
    queryFn: () => articlesApi.getBom(articleId!).then((r) => r.data),
  });
}

function useInvalidateBom(articleId: string | null) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['bom', articleId] });
    qc.invalidateQueries({ queryKey: ['routing-costing', articleId] });
    qc.invalidateQueries({ queryKey: ['routing-costing-history', articleId] });
  };
}

export function useAddBomItem(articleId: string | null) {
  const invalidate = useInvalidateBom(articleId);
  return useMutation({
    mutationFn: (body: { materialId: string; qtyPerUnit: number; operationType?: string }) =>
      articlesApi.addBomItem(articleId!, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useUpdateBomItem(articleId: string | null) {
  const invalidate = useInvalidateBom(articleId);
  return useMutation({
    mutationFn: (input: { id: string; qtyPerUnit: number }) =>
      articlesApi.updateBomItem(input.id, { qtyPerUnit: input.qtyPerUnit }).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useRemoveBomItem(articleId: string | null) {
  const invalidate = useInvalidateBom(articleId);
  return useMutation({
    mutationFn: (id: string) => articlesApi.removeBomItem(id).then((r) => r.data),
    onSuccess: invalidate,
  });
}

/** Заявки на номенклатуру («как в 1С») */
export function useNomenclatureRequests(status?: string) {
  return useQuery({
    queryKey: ['nomenclature-requests', status],
    queryFn: () => nomenclatureApi.list(status).then((r) => r.data),
  });
}

export function useCreateNomenclatureRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { proposedName: string; series?: string; description?: string; reason?: string }) =>
      nomenclatureApi.create(body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nomenclature-requests'] }),
  });
}

export function useDecideNomenclatureRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; decision: 'approve' | 'reject'; comment?: string }) => {
      if (input.decision === 'approve') {
        const r = await nomenclatureApi.approve(input.id, { comment: input.comment });
        return r.data.request;
      }
      const r = await nomenclatureApi.reject(input.id, input.comment);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['nomenclature-requests'] });
      qc.invalidateQueries({ queryKey: ['articles'] });
    },
  });
}
