import api from './client';

/**
 * Национальный каталог товаров (НКТ): коды NTIN для изделий ЦМК.
 * Разбор контракта и границы периметра — docs/nkt/API.md.
 */

/** Значения перечисления NktStatus на бэкенде */
export type NktStatus =
  | 'NEW'
  | 'DATA_INCOMPLETE'
  | 'NEED_REGISTRATION'
  | 'REQUEST_CREATED'
  | 'MODERATION'
  | 'MATCH_REVIEW'
  | 'REWORK'
  | 'REJECTED'
  | 'READY_TO_PUBLISH'
  | 'HAS_NTIN'
  | 'ERROR';

export interface NktRow {
  articleId: string;
  articleCode: string;
  articleName: string;
  /** Вид изделия — префикс артикула до дефиса */
  codePrefix: string;
  status: NktStatus;
  oktru: string;
  gtin: string;
  gtinValid: boolean;
  ntin: string;
  productUrl: string;
  attempts: number;
  lastError: string;
  moderatorComment: string;
  updatedAt: string | null;
  queuedOp: string;
}

export interface NktImage {
  fileName: string;
  imageType: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
}

export interface NktRevisionDetail {
  attributeCode: string;
  value: string;
  comment: string;
}

/** Похожая карточка, найденная самим НКТ при создании заявки */
export interface NktDuplicate {
  orderNumber: number;
  name: string;
  brand: string;
  gtin: string;
  ntin: string;
  similarity: number;
}

export interface NktCard extends Omit<NktRow, 'status'> {
  id: string;
  status: NktStatus;
  tnved: string;
  nameRu: string;
  nameKk: string;
  brand: string;
  attributes: Record<string, string>;
  images: NktImage[];
  requestId: string;
  requestStatusRaw: string;
  revisionDetails: NktRevisionDetail[] | null;
  duplicates: NktDuplicate[] | null;
  ntinSource: string;
  autoPublication: boolean;
  lastSyncAt: string | null;
  nextRetryAt: string | null;
  publishedAt: string | null;
}

/** Атрибут из схемы НКТ: по нему рисуется поле формы паспорта */
export interface NktSchemaAttr {
  code: string;
  group: 'BASE' | 'MAIN_EXT' | 'ADDITIONAL_EXT';
  nameRu: string;
  nameKk: string;
  descriptionRu: string;
  dataType: 'string' | 'text' | 'number' | 'boolean' | 'dictionary' | 'multiDictionary' | 'date';
  isRequired: boolean;
  dictionaryCode: string;
  pattern: string;
  maxLength: number;
  minValue: string;
  maxValue: string;
  order: number;
}

export interface NktPassport {
  oktru: string;
  tnved: string;
  gtin: string;
  nameRu: string;
  nameKk: string;
  brand: string;
  attributes: Record<string, string>;
  images: NktImage[];
}

export interface NktIssue {
  code: string;
  name: string;
  message: string;
}

export interface NktCategory {
  codePrefix: string;
  oktru: string;
  oktruName: string;
  tnvedDefault: string;
  isActive: boolean;
  articles: number;
}

export interface NktSummary {
  byStatus: Partial<Record<NktStatus, number>>;
  total: number;
  withNtin: number;
  sharePct: number;
  problem: number;
  configured: boolean;
}

export interface NktLogEntry {
  id: number;
  direction: string;
  method: string;
  url: string;
  httpCode: number;
  requestBody: string;
  responseBody: string;
  durationMs: number;
  createdAt: string;
}

export const nktApi = {
  cards: (params?: Record<string, string | number>) =>
    api.get<{ data: NktRow[]; meta: { page: number; pageSize: number; total: number } }>('/nkt/cards', { params }),
  summary: () => api.get<NktSummary>('/nkt/summary'),
  status: () => api.get<{
    configured: boolean; baseUrl: string; queued: number;
    attributes: number; dictionaryValues: number; schemaSyncedAt: string | null;
  }>('/nkt/status'),
  card: (articleId: string) =>
    api.get<{ card: NktCard; schema: NktSchemaAttr[] }>(`/nkt/cards/${articleId}`),
  savePassport: (articleId: string, body: NktPassport) =>
    api.put<NktCard>(`/nkt/cards/${articleId}/passport`, body),
  validate: (articleId: string) =>
    api.post<{ ok: boolean; issues: NktIssue[] }>(`/nkt/cards/${articleId}/validate`),
  submit: (articleId: string) => api.post<NktCard>(`/nkt/cards/${articleId}/submit`),
  resubmit: (articleId: string) => api.post<NktCard>(`/nkt/cards/${articleId}/resubmit`),
  decideDuplicate: (articleId: string, decision: 'CONTINUE' | 'USE_EXISTING', ntin?: string) =>
    api.post<NktCard>(`/nkt/cards/${articleId}/duplicate-decision`, { decision, ntin }),
  cancel: (articleId: string) => api.post<NktCard>(`/nkt/cards/${articleId}/cancel`),
  log: (articleId: string) => api.get<{ data: NktLogEntry[] }>(`/nkt/cards/${articleId}/log`),
  categories: () => api.get<{ data: NktCategory[] }>('/nkt/categories'),
  saveCategory: (prefix: string, body: { oktru: string; oktruName?: string; tnvedDefault?: string; isActive?: boolean }) =>
    api.put<{ ok: boolean }>(`/nkt/categories/${prefix}`, body),
  dictionary: (code: string, search?: string) =>
    api.get<{ data: Array<{ value: string; label: string }> }>(`/nkt/dictionaries/${code}`, { params: search ? { search } : undefined }),
  syncSchema: () => api.post<{ ok: boolean }>('/nkt/sync-schema'),
};

/** Подпись статуса и оттенок. Цвет украшает смысл, но не несёт его один */
export const NKT_STATUS: Record<NktStatus, { label: string; hue: 'indigo' | 'emerald' | 'rose' | 'amber' | 'none'; hint: string }> = {
  NEW: { label: 'Новое', hue: 'none', hint: 'ещё не проверялось' },
  DATA_INCOMPLETE: { label: 'Нет данных', hue: 'rose', hint: 'паспорт заполнен не полностью' },
  NEED_REGISTRATION: { label: 'Готово к подаче', hue: 'indigo', hint: 'паспорт полон, ждёт очереди' },
  REQUEST_CREATED: { label: 'Заявка создана', hue: 'indigo', hint: 'черновик в НКТ' },
  MODERATION: { label: 'На модерации', hue: 'indigo', hint: 'ответ НКТ — 3–10 рабочих дней' },
  MATCH_REVIEW: { label: 'Проверка совпадений', hue: 'amber', hint: 'НКТ нашёл похожие карточки' },
  REWORK: { label: 'На доработке', hue: 'amber', hint: 'модератор вернул с замечаниями' },
  REJECTED: { label: 'Отклонено', hue: 'rose', hint: 'нужен ручной разбор' },
  READY_TO_PUBLISH: { label: 'Готово к публикации', hue: 'indigo', hint: 'модерация пройдена' },
  HAS_NTIN: { label: 'NTIN получен', hue: 'emerald', hint: 'цель достигнута' },
  ERROR: { label: 'Ошибка обмена', hue: 'rose', hint: 'разбор по журналу' },
};
