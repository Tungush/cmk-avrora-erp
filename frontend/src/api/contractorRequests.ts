import api from './client';

/**
 * Заявки на подряд (26.08.2026).
 *
 * Поток: заявка заводится ПАРТИЕЙ, когда заказы ещё не известны («увезли
 * красить балки») → пачкой уходит одной сделкой в воронку Б24 «Заказ на
 * Работы» → цех разносит объём по заказам → приходит акт, и сумма делится
 * между заказами пропорционально объёму.
 *
 * Модуль — тонкая типизированная обёртка над контрактом бэкенда: типы
 * повторяют то, что реально отдаёт allocationSummary(), а не то, что
 * удобно интерфейсу. Каждый вызов сразу разворачивает `data` axios —
 * компонентам нужен ответ, а не транспорт.
 */

export type RoutingStageCode = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';
export type RateTypeCode = 'PER_HOUR' | 'PER_UNIT' | 'PER_KG' | 'PER_TON' | 'FIXED';
export type WorkLocationCode = 'OUR_SHOP' | 'CONTRACTOR_SITE';
export type ContractorRequestStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'ALLOCATED' | 'CANCELLED';

/** Единицы объёма ставки — копия RATE_UNITS бэкенда, чтобы «3,2» не читалось как штуки */
export const RATE_UNITS: Record<RateTypeCode, string> = {
  PER_HOUR: 'ч', PER_UNIT: 'шт', PER_KG: 'кг', PER_TON: 'т', FIXED: 'ед.',
};

export const RATE_TYPE_LABELS: Record<RateTypeCode, string> = {
  PER_HOUR: 'за час', PER_UNIT: 'за штуку', PER_KG: 'за килограмм',
  PER_TON: 'за тонну', FIXED: 'фиксированная сумма',
};

/** Подпись ставки в таблице: 12 000 ₸/т */
export const RATE_SUFFIXES: Record<RateTypeCode, string> = {
  PER_HOUR: '₸/ч', PER_UNIT: '₸/шт', PER_KG: '₸/кг', PER_TON: '₸/т', FIXED: '₸ фикс',
};

export const REQUEST_STATUS_LABELS: Record<ContractorRequestStatus, string> = {
  DRAFT: 'черновик',
  SENT: 'в Б24',
  ACCEPTED: 'принята по акту',
  ALLOCATED: 'разнесена',
  CANCELLED: 'отменена',
};

export const REQUEST_STATUS_COLORS: Record<ContractorRequestStatus, string> = {
  DRAFT: 'orange', SENT: 'blue', ACCEPTED: 'warning', ALLOCATED: 'success', CANCELLED: 'gray',
};

export interface ContractorRef {
  id: string;
  name: string;
  binIin?: string | null;
}

export interface OrderRefShort {
  id: string;
  orderNumber: string;
}

/** То, что отдаёт allocationSummary() — строка списка заявок */
export interface AllocationSummary {
  id: string;
  number: string;
  routingStage: RoutingStageCode;
  stageLabel: string;
  status: ContractorRequestStatus;
  rateType: RateTypeCode;
  unit: string;
  rate: number | null;
  plannedQty: number | null;
  estimatedAmount: number | null;
  actualQty: number | null;
  actualAmount: number | null;
  totalAmount: number | null;
  workLocation: WorkLocationCode;
  plannedHours: number | null;
  contractor: ContractorRef | null;
  bitrixDealId: string | null;
  bitrixSentAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  daysSinceAccepted: number | null;
  ordersCount: number;
  orders: OrderRefShort[];
  allocatedQty: number;
  allocatedAmount: number;
  unallocatedQty: number | null;
  unallocatedAmount: number;
  /** Принята, но по заказам не разошлась — деньги висят в воздухе */
  needsAllocation: boolean;
  isStale: boolean;
  /** «Заказ поставщику» из 1С, которым Б24 оформил эту заявку */
  supplierDoc: { doNumber: string; totalAmount: number } | null;
  /** Свежий непривязанный ДО подрядчика — похоже, 1С ответила на заявку */
  candidateDoc: { doNumber: string; totalAmount: number } | null;
}

export interface ContractorRequestsResponse {
  data: AllocationSummary[];
  unallocated: { requests: number; amount: number };
  total: number;
}

/** Строка разнесения: сколько этой заявки ушло в конкретный заказ */
export interface AllocationRow {
  id: string;
  order: {
    id: string;
    orderNumber: string;
    status: string;
    plannedShipmentDate: string | null;
  } | null;
  share: number;
  qty: number | null;
  amount: number | null;
  plannedHours: number | null;
  decidedAt: string;
  acceptedAt: string | null;
}

/** ДО из 1С по этому подрядчику — сверка и основание приёмки, связь по БИН */
export interface SupplierAct {
  id: string;
  doNumber: string;
  doDate: string | null;
  totalAmount: number;
  orderId: string | null;
  /** Занят другой заявкой — в кандидаты приёмки не годится */
  linkedRequestNumber: string | null;
}

export interface ContractorRequestDetail extends AllocationSummary {
  description: string;
  note: string | null;
  works: AllocationRow[];
  supplierActs: SupplierAct[];
}

/** Ответ POST/PATCH — сырая запись Prisma: Decimal приходит строкой */
export interface ContractorRequestRecord {
  id: string;
  number: string;
  routingStage: RoutingStageCode;
  description: string;
  rateType: RateTypeCode;
  status: ContractorRequestStatus;
  workLocation: WorkLocationCode;
  contractorId: string | null;
  contractor?: { id: string; name: string } | null;
  createdAt: string;
}

export interface CreateRequestBody {
  routingStage: RoutingStageCode;
  description: string;
  rateType?: RateTypeCode;
  plannedQty?: number | null;
  rate?: number | null;
  estimatedAmount?: number | null;
  contractorId?: string | null;
  workLocation?: WorkLocationCode;
  plannedHours?: number | null;
  note?: string | null;
}

export interface UpdateRequestBody {
  contractorId?: string | null;
  rate?: number | null;
  rateType?: RateTypeCode;
  plannedQty?: number | null;
  estimatedAmount?: number | null;
  plannedHours?: number | null;
  description?: string;
  note?: string | null;
  workLocation?: WorkLocationCode;
}

export interface SendToBitrixResult {
  sent: number;
  dealId: string;
  totalEstimate: number;
}

export interface AllocateResult {
  workId: string;
  orderNumber: string;
  qty: number;
  unit: string;
  stageLabel: string;
  /** >0 — пересчёт задел чужие заказы, про это надо сказать вслух */
  recalculatedRows: number;
  remainingQty: number | null;
}

export interface AcceptResult {
  supplierDocNumber: string | null;
  accepted: true;
  actualQty: number;
  actualAmount: number;
  allocatedRows: number;
  split: Array<{ orderNumber: string; qty: number; amount: number }>;
  unallocatedQty: number;
}

export interface Contractor {
  id: string;
  name: string;
  binIin: string | null;
  defaultRateType: RateTypeCode;
  defaultRate: number | string;
  defaultWorkLocation: WorkLocationCode;
  isActive: boolean;
  notes: string | null;
}

export interface CreateContractorBody {
  name: string;
  binIin?: string | null;
  defaultRateType?: RateTypeCode;
  defaultRate?: number | null;
  defaultWorkLocation?: WorkLocationCode;
  notes?: string | null;
}

export const contractorRequestsApi = {
  list: (params?: { status?: string; stage?: string; contractorId?: string }) =>
    api.get<ContractorRequestsResponse>('/contractor-requests', { params })
      .then((r) => r.data),

  get: (id: string) =>
    api.get<ContractorRequestDetail>(`/contractor-requests/${id}`).then((r) => r.data),

  create: (body: CreateRequestBody) =>
    api.post<ContractorRequestRecord>('/contractor-requests', body).then((r) => r.data),

  update: (id: string, body: UpdateRequestBody) =>
    api.patch<ContractorRequestRecord>(`/contractor-requests/${id}`, body).then((r) => r.data),

  /** Пачка заявок → ОДНА сделка в воронке Б24 «Заказ на Работы» */
  sendToBitrix: (ids: string[]) =>
    api.post<SendToBitrixResult>('/contractor-requests/send-to-bitrix', { ids })
      .then((r) => r.data),

  /** «Из ПОДР-007 на этот заказ ушло 3,2 т» */
  allocate: (id: string, body: {
    orderId: string; orderLineId?: string | null; qty: number; share?: number; note?: string;
  }) => api.post<AllocateResult>(`/contractor-requests/${id}/allocate`, body).then((r) => r.data),

  removeAllocation: (id: string, workId: string) =>
    api.delete<{ deleted: boolean; recalculatedRows: number }>(
      `/contractor-requests/${id}/allocations/${workId}`,
    ).then((r) => r.data),

  /** Приёмка партии: сумма из ДО 1С (paymentDocumentId) или руками */
  accept: (id: string, body: {
    actualQty: number; actualAmount?: number;
    paymentDocumentId?: string | null; note?: string;
  }) =>
    api.post<AcceptResult>(`/contractor-requests/${id}/accept`, body).then((r) => r.data),

  cancel: (id: string) =>
    api.post<ContractorRequestRecord>(`/contractor-requests/${id}/cancel`, {}).then((r) => r.data),

  contractors: () =>
    api.get<Contractor[]>('/contractors').then((r) => r.data),

  createContractor: (body: CreateContractorBody) =>
    api.post<Contractor>('/contractors', body).then((r) => r.data),
};

/**
 * Сообщение бэкенда как есть: там уже человеческие русские формулировки
 * («свободно 4,2 т», «уже отдано 60 % работ этого вида»), и заменять их
 * своим «ошибка сохранения» — значит выбрасывать единственную подсказку.
 */
export function apiErrorMessage(e: unknown, fallback: string): string {
  const message = (e as { response?: { data?: { error?: { message?: string } } } })
    ?.response?.data?.error?.message;
  return message ?? fallback;
}
