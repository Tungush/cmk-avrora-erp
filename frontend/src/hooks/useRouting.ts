import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  routingApi, priceReviewsApi, RoutingResponse, CostingResponse, RoutingStageCode, WorkCenter,
} from '../api/routing';

/** Демо-данные (пример k-001 из «Спецификации 2022») — когда бэкенд недоступен */
const DEMO_ROUTING: RoutingResponse = {
  articleId: 'demo',
  rates: { hourlyRate: 2040, logisticsPct: 0.03, utilitiesPct: 0.01, marginPct: 0.1 },
  stages: [
    {
      stage: 'CUTTING', label: 'Резка', exists: true, workers: 2, hoursPerUnit: 0.07,
      workCenter: { id: 'wc-cut', code: 'CUT-1', name: 'Резка-1', hourlyRate: 2040 },
      hourlyRate: 2040, manHours: 0.14, stageCost: 285.6,
      actualWorkers: 2, actualHours: 0.082, actualDeviationPct: 17.14,
      notes: null, updatedAt: null,
    },
    {
      stage: 'ASSEMBLY', label: 'Сборка / сварка / обшивка', exists: true, workers: 1, hoursPerUnit: 0.15,
      workCenter: { id: 'wc-asm', code: 'ASM-1', name: 'Сварка-1', hourlyRate: 2040 },
      hourlyRate: 2040, manHours: 0.15, stageCost: 306,
      actualWorkers: 1, actualHours: 0.148, actualDeviationPct: -1.33,
      notes: null, updatedAt: null,
    },
    {
      stage: 'PAINTING', label: 'Зачистка / покраска', exists: true, workers: 1, hoursPerUnit: 0.04,
      workCenter: { id: 'wc-pnt', code: 'PNT-1', name: 'Покраска-1', hourlyRate: 2040 },
      hourlyRate: 2040, manHours: 0.04, stageCost: 81.6,
      actualWorkers: null, actualHours: null, actualDeviationPct: null,
      notes: null, updatedAt: null,
    },
  ],
};

const DEMO_COSTING: CostingResponse = {
  articleId: 'demo',
  result: {
    materialCost: 243, totalManHours: 0.33, laborCost: 673.2,
    logisticsCost: 7.29, utilitiesCost: 2.43, totalCost: 925.92,
    margin: 92.59, price: 1018.51,
  },
  explain: {
    lines: [
      { label: 'Материалы', value: 243, unit: '₸', source: 'bom' },
      { label: 'Резка', value: 285.6, unit: '₸', source: 'routing', formula: '2 чел × 0.07 ч × 2040 ₸/час' },
      { label: 'Сборка / сварка / обшивка', value: 306, unit: '₸', source: 'routing', formula: '1 чел × 0.15 ч × 2040 ₸/час' },
      { label: 'Зачистка / покраска', value: 81.6, unit: '₸', source: 'routing', formula: '1 чел × 0.04 ч × 2040 ₸/час' },
      { label: 'Логистика', value: 7.29, unit: '₸', source: 'costingConfig', formula: 'материалы × 3 %' },
      { label: 'Вода / газ / электричество', value: 2.43, unit: '₸', source: 'costingConfig', formula: 'материалы × 1 %' },
      { label: 'Себестоимость', value: 925.92, unit: '₸' },
      { label: 'Маржа', value: 92.59, unit: '₸', formula: 'себестоимость × 10 %' },
      { label: 'Расчётная цена', value: 1018.51, unit: '₸' },
    ],
    totalManHours: 0.33,
    priceCheck: { approvedPrice: 715, deviationPct: -29.8, belowCost: true },
  },
};

const DEMO_WORK_CENTERS: WorkCenter[] = [
  { id: 'wc-cut', code: 'CUT-1', name: 'Резка-1', stage: 'CUTTING', hourlyRate: 2040 },
  { id: 'wc-asm', code: 'ASM-1', name: 'Сварка-1', stage: 'ASSEMBLY', hourlyRate: 2040 },
  { id: 'wc-asm2', code: 'ASM-2', name: 'Сварка-2', stage: 'ASSEMBLY', hourlyRate: 2040 },
  { id: 'wc-pnt', code: 'PNT-1', name: 'Покраска-1', stage: 'PAINTING', hourlyRate: 2040 },
];

export function useRouting(articleId: string | null) {
  return useQuery({
    queryKey: ['routing', articleId],
    enabled: !!articleId,
    queryFn: () =>
      routingApi.get(articleId!).then((r) => r.data).catch(() => DEMO_ROUTING),
  });
}

export function useCosting(articleId: string | null) {
  return useQuery({
    queryKey: ['routing-costing', articleId],
    enabled: !!articleId,
    queryFn: () =>
      routingApi.costing(articleId!).then((r) => r.data).catch(() => DEMO_COSTING),
  });
}

export function useWorkCenters() {
  return useQuery({
    queryKey: ['work-centers'],
    queryFn: () => routingApi.workCenters().then((r) => r.data).catch(() => DEMO_WORK_CENTERS),
  });
}

function useInvalidateRouting(articleId: string | null) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['routing', articleId] });
    qc.invalidateQueries({ queryKey: ['routing-costing', articleId] });
    qc.invalidateQueries({ queryKey: ['routing-norm-history', articleId] });
    qc.invalidateQueries({ queryKey: ['routing-costing-history', articleId] });
  };
}

export function useSaveNorm(articleId: string | null) {
  const invalidate = useInvalidateRouting(articleId);
  return useMutation({
    mutationFn: (input: {
      stage: RoutingStageCode;
      workers: number;
      hoursPerUnit: number;
      workCenterId?: string;
      reason?: string;
    }) => routingApi.putNorm(articleId!, input.stage, input),
    onSuccess: invalidate,
  });
}

export function useSaveActual(articleId: string | null) {
  const invalidate = useInvalidateRouting(articleId);
  return useMutation({
    mutationFn: (input: { stage: RoutingStageCode; actualWorkers: number; actualHours: number }) =>
      routingApi.postActual(articleId!, input.stage, input),
    onSuccess: invalidate,
  });
}

export function usePromoteActual(articleId: string | null) {
  const invalidate = useInvalidateRouting(articleId);
  return useMutation({
    mutationFn: (stage: RoutingStageCode) => routingApi.promote(articleId!, stage),
    onSuccess: invalidate,
  });
}

/** Предпросмотр влияния правки нормы — вызывается до сохранения (§2.3 ④) */
export function usePreviewNorm(articleId: string | null) {
  return useMutation({
    mutationFn: (input: {
      stage: RoutingStageCode;
      workers: number;
      hoursPerUnit: number;
      workCenterId?: string | null;
    }) => routingApi.previewNorm(articleId!, input).then((r) => r.data),
  });
}

/** «Где применяется»: активные заказы с этим артикулом */
export function useUsage(articleId: string | null) {
  return useQuery({
    queryKey: ['routing-usage', articleId],
    enabled: !!articleId,
    queryFn: () => routingApi.usage(articleId!).then((r) => r.data),
  });
}

/** История изменения норм (RoutingOperationHistory) */
export function useNormHistory(articleId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['routing-norm-history', articleId],
    enabled: !!articleId && enabled,
    queryFn: () => routingApi.history(articleId!).then((r) => r.data),
  });
}

/** Снимки калькуляции (ArticleCosting) */
export function useCostingHistory(articleId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['routing-costing-history', articleId],
    enabled: !!articleId && enabled,
    queryFn: () => routingApi.costingHistory(articleId!).then((r) => r.data),
  });
}

/** Заявки на пересмотр цен (§3.4) */
export function usePriceReviews(status?: string) {
  return useQuery({
    queryKey: ['price-reviews', status],
    queryFn: () => priceReviewsApi.list(status ? { status } : undefined).then((r) => r.data),
  });
}

export function useRequestPriceReview(articleId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => priceReviewsApi.request(articleId!, reason).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['price-reviews'] }),
  });
}

export function useDecidePriceReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject'; newPrice?: number; comment?: string }) =>
      input.decision === 'approve'
        ? priceReviewsApi.approve(input.id, input.newPrice!, input.comment).then((r) => r.data)
        : priceReviewsApi.reject(input.id, input.comment).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['price-reviews'] });
      qc.invalidateQueries({ queryKey: ['routing-costing'] });
      qc.invalidateQueries({ queryKey: ['articles'] });
    },
  });
}
