import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../api/client';

export interface SavedView {
  id: string;
  module: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
}

/** Сохраняемые представления (§2.1): «Мои просроченные», «Q1 Телеком» */
export function useSavedViews(module: string) {
  return useQuery({
    queryKey: ['saved-views', module],
    queryFn: () => api.get<SavedView[]>('/saved-views', { params: { module } }).then((r) => r.data),
  });
}

export function useCreateSavedView(module: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; config: Record<string, unknown> }) =>
      api.post<SavedView>('/saved-views', { module, ...input }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views', module] }),
  });
}

export function useDeleteSavedView(module: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/saved-views/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views', module] }),
  });
}
