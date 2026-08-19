import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export const ONEC_BASE_URL = process.env.ONEC_BASE_URL || '';
export const ONEC_LOGIN = process.env.ONEC_LOGIN || '';
export const ONEC_PASSWORD = process.env.ONEC_PASSWORD || '';
export const ONEC_TIMEOUT_MS = Number(process.env.ONEC_TIMEOUT_MS || 20_000);

/** Строка номенклатуры заказа клиента (GET A) */
export interface OneCOrderItem {
  item?: string;
  item_code?: string;
  qty?: number | string;
  item_status?: string;
  unitprice?: number | string;
  tax?: number | string;
  amount?: number | string;
}

/** Оплата по заказу клиента (GET A) */
export interface OneCOrderPayment {
  clientorder_paid_amount?: number | string;
  clientorder_invoice_id?: string;
  clientorder_paydate?: string;
}

/** Заказ клиента — ответ GET A */
export interface OneCClientOrder {
  clientorder_num?: string;
  clientorder_adem?: string;
  clientorder_date?: string;
  clientorder_year?: string;
  client_po?: string;
  clientorder_status?: string;
  clientorder_approval_status?: string;
  workplandate?: string;
  client_agreement?: string;
  division_code?: string;
  client?: string;
  client_bin?: string;
  final_client?: string;
  our_company?: string;
  our_bin?: string;
  project_group?: string;
  project_site?: string;
  region?: string;
  project_manager?: string;
  work_type?: string;
  project_type?: string;
  description?: string;
  author?: string;
  items?: OneCOrderItem[];
  clientorder_pay_data?: OneCOrderPayment[];
  [key: string]: unknown;
}

/** Заказ поставщику — ответ GET C */
export interface OneCSupplierOrder {
  supplier_invoice_num?: string;
  supplier_invoice_adem?: string;
  supplier_invoice_date?: string;
  supplier_invoice_status?: string;
  supplier_invoice_ext?: string;
  supplier_agreement?: string;
  project_group?: string;
  region?: string;
  buyer?: string;
  approver?: string;
  our_company?: string;
  supplier?: string;
  supplier_bin?: string;
  description?: string;
  supplier_invoice_category?: string;
  supplier_invoice_notpaid_amount?: number | string;
  currency?: string;
  supplier_invoice_alldata?: Array<{
    supplier_invoice_paid_amount?: number | string;
    supplier_invoice_id?: string;
    supplier_invoice_paydate?: string;
  }>;
  item_alldata?: Array<{
    item?: string;
    item_code?: string;
    expense_category?: string;
    qty?: number | string;
    unit_measure?: string;
    unit_price?: number | string;
    tax?: number | string;
    clientorder_num?: string;
    amount?: number | string;
  }>;
  actdoc_alldata?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Обороты по заказу клиента — ответ GET D */
export interface OneCTurnover {
  clientorder_num?: string;
  clientorder_adem?: string;
  clientorder_date?: string;
  supplier_invoice_alldata?: Array<{
    supplier_invoice_num?: string;
    supplier_invoice_adem?: string;
    supplier_invoice_date?: string;
    supplier?: string;
    supplier_bin?: string;
    currency?: string;
    item?: string;
    item_amount?: number | string;
    item_paid_amount?: number | string;
  }>;
  [key: string]: unknown;
}

/**
 * Разбор номера заказа на пару «номер + год», как того требуют GET-запросы.
 *
 * В базе два формата, оба реальные:
 *  - «Т7АА-002345-2026» — номер 1С: последняя группа это год → num + year;
 *  - «П-100014-22»      — номер прежней системы (Адем) → ищем по clientorder_adem.
 */
export function parseOrderNumber(orderNumber: string): {
  kind: 'onec' | 'adem';
  num: string;
  year?: string;
} {
  const trimmed = orderNumber.trim();
  const m = /^(.+)-(\d{4})$/.exec(trimmed);
  if (m) return { kind: 'onec', num: m[1], year: m[2] };
  return { kind: 'adem', num: trimmed };
}

/**
 * Клиент HTTP-сервисов 1С (ТЗ для запросов GET, v10).
 *
 * Четыре запроса:
 *   A — заказ клиента          /erp/hs/fm/orders
 *   B — счета и акты           /erp/hs/fm/invoices
 *   C — заказ поставщику       /erp/hs/TurnOver/v1/get_c
 *   D — обороты по заказу      /erp/hs/TurnOver/v1/get_d
 *
 * Все они точечные: принимают конкретный номер документа. Списка «всё, что
 * изменилось с даты» в ТЗ нет — отсюда стратегия синхронизации в §4
 * 08_INTEGRATION_1C.md: мы обходим номера, которые уже знаем.
 */
@Injectable()
export class OneCClientService {
  private readonly logger = new Logger(OneCClientService.name);

  get configured(): boolean {
    return !!ONEC_BASE_URL;
  }

  private async get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    if (!this.configured) {
      throw new ServiceUnavailableException({
        code: 'ONEC_NOT_CONFIGURED',
        message: 'Адрес 1С не задан (ONEC_BASE_URL)',
      });
    }
    const url = new URL(`${ONEC_BASE_URL.replace(/\/$/, '')}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (ONEC_LOGIN) {
      headers.Authorization = `Basic ${Buffer.from(`${ONEC_LOGIN}:${ONEC_PASSWORD}`).toString('base64')}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ONEC_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`1С ${path} вернула ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const text = await res.text();
    if (!text.trim()) return [] as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`1С ${path}: ответ не JSON — ${text.slice(0, 200)}`);
    }
  }

  /** GET A — заказ клиента со строками и оплатами */
  async getClientOrder(orderNumber: string): Promise<OneCClientOrder[]> {
    const p = parseOrderNumber(orderNumber);
    const params = p.kind === 'onec'
      ? { clientorder_num: p.num, clientorder_year: p.year }
      : { clientorder_adem: p.num };
    const data = await this.get<OneCClientOrder | OneCClientOrder[]>('/erp/hs/fm/orders', params);
    return Array.isArray(data) ? data : [data];
  }

  /** GET B — счета и акты по документу */
  async getInvoices(invoiceNumber: string): Promise<Record<string, unknown>[]> {
    const p = parseOrderNumber(invoiceNumber);
    const params = p.kind === 'onec'
      ? { invoice_num: p.num, invoice_year: p.year }
      : { invoice_num: p.num };
    const data = await this.get<Record<string, unknown> | Record<string, unknown>[]>('/erp/hs/fm/invoices', params);
    return Array.isArray(data) ? data : [data];
  }

  /** GET C — заказ поставщику: закуп, оплаты, закрывающие документы */
  async getSupplierOrder(number: string): Promise<OneCSupplierOrder[]> {
    const p = parseOrderNumber(number);
    const params = p.kind === 'onec'
      ? { supplier_invoice_num: p.num, supplier_invoice_year: p.year }
      : { supplier_invoice_adem: p.num };
    const data = await this.get<OneCSupplierOrder | OneCSupplierOrder[]>('/erp/hs/TurnOver/v1/get_c', params);
    return Array.isArray(data) ? data : [data];
  }

  /** GET D — обороты: какие заказы поставщику идут под этот заказ клиента */
  async getTurnover(orderNumber: string): Promise<OneCTurnover[]> {
    const p = parseOrderNumber(orderNumber);
    const params = p.kind === 'onec'
      ? { clientorder_num: p.num, clientorder_year: p.year }
      : { clientorder_adem: p.num };
    const data = await this.get<OneCTurnover | OneCTurnover[]>('/erp/hs/TurnOver/v1/get_d', params);
    return Array.isArray(data) ? data : [data];
  }

  /** Проверка связи — для экрана «Обмен с 1С» */
  async ping(sampleOrderNumber: string): Promise<{ ok: boolean; message: string }> {
    try {
      const rows = await this.getClientOrder(sampleOrderNumber);
      return { ok: true, message: `Ответ получен: ${rows.length} запис(и)` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Неизвестная ошибка' };
    }
  }
}
