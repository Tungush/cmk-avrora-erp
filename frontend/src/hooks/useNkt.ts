import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nktApi, type NktPassport } from '../api/nkt';

/** Обновить всё, что могло измениться после действия по одному изделию */
function useInvalidate() {
  const qc = useQueryClient();
  return (articleId?: string) => {
    qc.invalidateQueries({ queryKey: ['nkt', 'cards'] });
    qc.invalidateQueries({ queryKey: ['nkt', 'summary'] });
    if (articleId) {
      qc.invalidateQueries({ queryKey: ['nkt', 'card', articleId] });
      qc.invalidateQueries({ queryKey: ['nkt', 'log', articleId] });
    }
  };
}

export function useNktCards(params: Record<string, string | number>) {
  return useQuery({
    queryKey: ['nkt', 'cards', params],
    queryFn: () => nktApi.cards(params).then((r) => r.data),
  });
}

export function useNktSummary() {
  return useQuery({
    queryKey: ['nkt', 'summary'],
    queryFn: () => nktApi.summary().then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useNktStatus() {
  return useQuery({
    queryKey: ['nkt', 'status'],
    queryFn: () => nktApi.status().then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useNktCard(articleId: string | null) {
  return useQuery({
    queryKey: ['nkt', 'card', articleId],
    queryFn: () => nktApi.card(articleId as string).then((r) => r.data),
    enabled: !!articleId,
  });
}

export function useNktLog(articleId: string | null) {
  return useQuery({
    queryKey: ['nkt', 'log', articleId],
    queryFn: () => nktApi.log(articleId as string).then((r) => r.data.data),
    enabled: !!articleId,
  });
}

export function useNktCategories() {
  return useQuery({
    queryKey: ['nkt', 'categories'],
    queryFn: () => nktApi.categories().then((r) => r.data.data),
  });
}

export function useSaveNktPassport(articleId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: NktPassport) => nktApi.savePassport(articleId, body).then((r) => r.data),
    onSuccess: () => invalidate(articleId),
  });
}

export function useValidateNkt(articleId: string) {
  return useMutation({
    mutationFn: () => nktApi.validate(articleId).then((r) => r.data),
  });
}

/**
 * Действия менеджера. Все ведут в очередь или к самому НКТ, поэтому после
 * каждого перечитываются и карточка, и реестр: статус меняется не тем
 * значением, которое вернул вызов, а тем, что решил каталог.
 */
export function useNktAction(articleId: string) {
  const invalidate = useInvalidate();
  return {
    submit: useMutation({
      mutationFn: () => nktApi.submit(articleId).then((r) => r.data),
      onSuccess: () => invalidate(articleId),
    }),
    resubmit: useMutation({
      mutationFn: () => nktApi.resubmit(articleId).then((r) => r.data),
      onSuccess: () => invalidate(articleId),
    }),
    decide: useMutation({
      mutationFn: (v: { decision: 'CONTINUE' | 'USE_EXISTING'; ntin?: string }) =>
        nktApi.decideDuplicate(articleId, v.decision, v.ntin).then((r) => r.data),
      onSuccess: () => invalidate(articleId),
    }),
    cancel: useMutation({
      mutationFn: () => nktApi.cancel(articleId).then((r) => r.data),
      onSuccess: () => invalidate(articleId),
    }),
  };
}

export function useSaveNktCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { prefix: string; oktru: string; oktruName?: string; tnvedDefault?: string; isActive?: boolean }) =>
      nktApi.saveCategory(v.prefix, v).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['nkt', 'categories'] });
      qc.invalidateQueries({ queryKey: ['nkt', 'cards'] });
    },
  });
}

export function useSyncNktSchema() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => nktApi.syncSchema().then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nkt'] }),
  });
}
