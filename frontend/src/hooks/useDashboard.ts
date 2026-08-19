import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/dashboard';

export function useProductionSummary() {
  return useQuery({
    queryKey: ['dashboard-production'],
    queryFn: () => dashboardApi.getProductionSummary().then(res => res.data),
    retry: 0,
    staleTime: 30000,
  });
}
