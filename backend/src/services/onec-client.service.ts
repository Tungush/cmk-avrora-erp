import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export const ONEC_BASE_URL = process.env.ONEC_BASE_URL || '';
export const ONEC_LOGIN = process.env.ONEC_LOGIN || '';
export const ONEC_PASSWORD = process.env.ONEC_PASSWORD || '';
/** Сервисы /TurnOver/ опубликованы под отдельной учёткой (проверено на 10.10.10.81):
 *  учётка от /fm/ получает на них 401. Не задана — работаем общей. */
export const ONEC_TURNOVER_LOGIN = process.env.ONEC_TURNOVER_LOGIN || '';
export const ONEC_TURNOVER_PASSWORD = process.env.ONEC_TURNOVER_PASSWORD || '';
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

/** Вариант запроса к 1С: набор query-параметров, которым можно попробовать найти документ */
export interface LookupAttempt {
  kind: 'onec' | 'adem';
  num: string;
  year?: string;
}

const ONEC_WITH_YEAR = /^(.+?)-((?:19|20)\d{2})$/;   // Т7АА-002345-2026
const ADEM_SHORT_YEAR = /^.+-\d{2}$/;                 // П-100014-22
const NUMERIC = /^\d{4,10}$/;                         // 1151185 (supplier_invoice_adem из Лист3)

/**
 * Во что превратить наш номер, чтобы найти документ в 1С.
 *
 * Форматы, которые реально встречаются:
 *   «Т7АА-002345-2026» — номер 1С + год: последняя группа из четырёх цифр это год;
 *   «П-100014-22»      — прежняя система (Адем), год двузначный и частью номера не является;
 *   «LVАА-000135»      — номер 1С без года (пример из Лист3 ТЗ) — года мы не знаем;
 *   «1151185»          — чисто цифровой идентификатор Адем.
 *
 * Возвращаем НЕСКОЛЬКО вариантов, а не один: год в номере и год документа —
 * не одно и то же, и угадать по маске нельзя. Клиент пробует варианты по
 * очереди и берёт первый непустой ответ.
 */
export function lookupAttempts(orderNumber: string): LookupAttempt[] {
  const trimmed = orderNumber.trim();
  if (!trimmed) return [];

  // Чисто цифровой — это идентификатор прежней системы
  if (NUMERIC.test(trimmed)) return [{ kind: 'adem', num: trimmed }];

  const withYear = ONEC_WITH_YEAR.exec(trimmed);
  if (withYear) {
    // Основная догадка — «номер + год», запасная — весь текст как номер Адем
    return [
      { kind: 'onec', num: withYear[1], year: withYear[2] },
      { kind: 'adem', num: trimmed },
    ];
  }

  if (ADEM_SHORT_YEAR.test(trimmed)) {
    return [{ kind: 'adem', num: trimmed }];
  }

  // Номер без года: сначала как документ 1С (год не указываем), затем как Адем
  return [
    { kind: 'onec', num: trimmed },
    { kind: 'adem', num: trimmed },
  ];
}

/** Совместимость: первый вариант разбора */
export function parseOrderNumber(orderNumber: string): LookupAttempt {
  return lookupAttempts(orderNumber)[0] ?? { kind: 'adem', num: orderNumber };
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
    // Логин может быть кириллическим (1С_ERP_709) — Basic кодируем из UTF-8:
    // cp1251 тот же сервер отвергает с 401.
    const turnover = path.includes('/TurnOver/') && !!ONEC_TURNOVER_LOGIN;
    const login = turnover ? ONEC_TURNOVER_LOGIN : ONEC_LOGIN;
    const password = turnover ? ONEC_TURNOVER_PASSWORD : ONEC_PASSWORD;
    if (login) {
      headers.Authorization = `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ONEC_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`1С ${path} вернула ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const text = await res.text();
    if (!text.trim()) return [] as unknown as T;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`1С ${path}: ответ не JSON — ${text.slice(0, 200)}`);
    }
    // 1С нередко отвечает 200 с телом-ошибкой: не принимаем это за данные
    // …в том числе завёрнутым в массив: get_c на ненайденный документ отвечает
    // 200 и [{"error": "Заказ поставщику не найден"}]
    const errCarrier = Array.isArray(parsed) ? parsed[0] : parsed;
    if (errCarrier && typeof errCarrier === 'object') {
      const err = (errCarrier as Record<string, unknown>).error ?? (errCarrier as Record<string, unknown>).Error;
      if (err) throw new Error(`1С ${path}: ${String(err).slice(0, 200)}`);
    }
    return parsed as T;
  }

  /** Последний сырой ответ по каждому пути — чтобы при первом включении
   *  увидеть фактическую структуру JSON, а не гадать по документации */
  private readonly lastRaw = new Map<string, { at: string; params: unknown; sample: unknown }>();

  getLastRaw(): Record<string, { at: string; params: unknown; sample: unknown }> {
    return Object.fromEntries(this.lastRaw);
  }

  /** Перебор вариантов номера: берём первый непустой ответ */
  private async tryLookup<T>(
    path: string,
    orderNumber: string,
    build: (a: LookupAttempt) => Record<string, string | undefined>,
  ): Promise<T[]> {
    const attempts = lookupAttempts(orderNumber);
    let lastError: unknown = null;

    for (const attempt of attempts) {
      const params = build(attempt);
      try {
        const data = await this.get<T | T[]>(path, params);
        const rows = (Array.isArray(data) ? data : [data]).filter(Boolean) as T[];
        this.lastRaw.set(path, {
          at: new Date().toISOString(),
          params,
          sample: rows[0] ?? null,
        });
        if (rows.length > 0) return rows;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  /** GET A — заказ клиента со строками и оплатами */
  async getClientOrder(orderNumber: string): Promise<OneCClientOrder[]> {
    // Реальный /fm/orders отвечает 500 на любой запрос без clientorder_year
    // (в т.ч. на поиск по адем-номеру), поэтому год передаём всегда:
    // для «П-121794-24» берём его из двузначного хвоста, для номера без года
    // перебираем последние годы.
    return this.tryLookup<OneCClientOrder>('/erp/hs/fm/orders', orderNumber, (a) => {
      if (a.kind === 'onec') {
        return { clientorder_num: a.num, clientorder_year: a.year ?? String(new Date().getFullYear()) };
      }
      const shortYear = /-(\d{2})$/.exec(a.num);
      return {
        clientorder_adem: a.num,
        clientorder_year: shortYear ? `20${shortYear[1]}` : String(new Date().getFullYear()),
      };
    });
  }

  /** GET B — счета и акты по документу */
  async getInvoices(invoiceNumber: string): Promise<Record<string, unknown>[]> {
    return this.tryLookup<Record<string, unknown>>('/erp/hs/fm/invoices', invoiceNumber, (a) =>
      a.kind === 'onec'
        ? { invoice_num: a.num, invoice_year: a.year }
        : { invoice_num: a.num },
    );
  }

  /** GET C — заказ поставщику: закуп, оплаты, закрывающие документы */
  async getSupplierOrder(number: string, year?: string): Promise<OneCSupplierOrder[]> {
    // Год берём из строки get_d (supplier_invoice_year) — без него реальный
    // get_c документ по одному номеру не находит
    return this.tryLookup<OneCSupplierOrder>('/erp/hs/TurnOver/v1/get_c', number, (a) =>
      a.kind === 'onec'
        ? { supplier_invoice_num: a.num, supplier_invoice_year: a.year ?? year }
        : { supplier_invoice_adem: a.num },
    );
  }

  /** GET D — обороты: какие заказы поставщику идут под этот заказ клиента */
  async getTurnover(orderNumber: string): Promise<OneCTurnover[]> {
    return this.tryLookup<OneCTurnover>('/erp/hs/TurnOver/v1/get_d', orderNumber, (a) =>
      a.kind === 'onec'
        ? { clientorder_num: a.num, clientorder_year: a.year }
        : { clientorder_adem: a.num },
    );
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
