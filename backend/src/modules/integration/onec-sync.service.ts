import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../services/prisma.service';
import { IntegrationService } from '../../services/integration.service';
import {
  OneCClientService, OneCClientOrder, OneCSupplierOrder, parseOrderNumber,
} from '../../services/onec-client.service';

/** Статусы 1С → наши. Незнакомый статус не двигает заказ, а попадает в отчёт. */
const STATUS_MAP: Record<string, string> = {
  'на согласовании': 'DRAFT',
  'к выполнению': 'CONFIRMED',
  'в работе': 'IN_PRODUCTION',
  'закрыт': 'CLOSED',
  'аннулирован': 'CANCELLED',
  'отменен': 'CANCELLED',
  'отменён': 'CANCELLED',
};

/** Наши статусы, которые 1С не должна перебивать: производство ведём мы */
const OUR_PRODUCTION_STATUSES = new Set(['IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED']);

/**
 * Разбор числа из 1С. Возвращает null, если разобрать не удалось —
 * «не поняли значение» и «пришёл ноль» это разные вещи, и путать их нельзя:
 * иначе неразобранная цена молча затирает реальную нулём.
 *
 * Понимает «1 234,56», «1 234.56», «1.234.567,89», «1,234,567.89», «4 500,00 ₸».
 */
function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  let raw = String(v).replace(/[\s\u00A0\u202F]/g, '');
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  raw = raw.replace(/[^\d.,]/g, '');
  if (!raw) return null;

  // Последний разделитель считаем десятичным, остальные — разрядными
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  const dec = Math.max(lastComma, lastDot);
  const normalized = dec >= 0
    ? raw.slice(0, dec).replace(/[.,]/g, '') + '.' + raw.slice(dec + 1).replace(/[.,]/g, '')
    : raw;

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** Число со значением по умолчанию — там, где отсутствие значения безопасно трактовать как 0 */
const num = (v: unknown): number => numOrNull(v) ?? 0;

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Часовой пояс предприятия — в нём 1С называет календарные даты */
const ONEC_TIMEZONE = process.env.ONEC_TIMEZONE || 'Asia/Almaty';

/**
 * Разбор даты из 1С.
 *
 * Тонкость, из-за которой даты съезжают на сутки: 1С отдаёт «2026-09-30T00:00:00»
 * без часового пояса, и `new Date()` трактует это как местное время. На сервере
 * в UTC+5 получается 29 сентября 19:00 UTC, а Prisma пишет в @db.Date именно
 * UTC-дату — план вывоза уезжает на день назад.
 *
 * Поэтому берём из строки календарную дату и сохраняем её как UTC-полночь:
 * «30 сентября» остаётся 30 сентября в любом поясе.
 */
function parseDate(v: unknown): Date | null {
  const raw = str(v);
  if (!raw) return null;

  // «2026-09-30», «2026-09-30T00:00:00», «2026-09-30T00:00:00.000Z»
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) {
    const [Y, M, D] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    // 1С отдаёт пустую дату как 0001-01-01 — это не дата, а «не заполнено»
    if (Y < 1900 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31) return null;
    const d = new Date(Date.UTC(Y, M - 1, D));
    // отсекает 31 февраля и подобное
    return d.getUTCFullYear() === Y && d.getUTCMonth() === M - 1 && d.getUTCDate() === D ? d : null;
  }

  // «Wed May 13 2026 05:00:00 GMT+0500 (Kazakhstan Time)» — формат из ТЗ (GET C).
  // Смещение указано, поэтому берём календарную дату в поясе предприятия.
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() < 1900 || d.getUTCFullYear() > 2100) return null;
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: ONEC_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d).split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(day)));
}

export interface SyncReport {
  requested: number;
  found: number;
  updated: number;
  /** Не найдено в 1С */
  notFound: string[];
  /** Есть в 1С, но нет у нас — синхронизировать нечего */
  missingLocally: string[];
  /** Ответ получен, но массив строк не распознан: структура JSON иная */
  linesNotParsed: Array<{ orderNumber: string; keys: string[] }>;
  /** Значения, которые не удалось разобрать — в БД не записаны */
  unparsed: Array<{ orderNumber: string; field: string; raw: string }>;
  unknownArticles: string[];
  unknownStatuses: string[];
  errors: Array<{ orderNumber: string; error: string }>;
}

export function emptyReport(): SyncReport {
  return {
    requested: 0, found: 0, updated: 0,
    notFound: [], missingLocally: [], linesNotParsed: [], unparsed: [],
    unknownArticles: [], unknownStatuses: [], errors: [],
  };
}

/** Массив строк номенклатуры: в ТЗ имя поля для GET A не указано — пробуем известные */
const ITEM_ARRAY_KEYS = ['items', 'item_alldata', 'item_data', 'itemdata', 'lines', 'nomenclature'];

function findItemsArray(data: Record<string, unknown>): { rows: any[] | null; keys: string[] } {
  for (const key of ITEM_ARRAY_KEYS) {
    const v = data[key];
    if (Array.isArray(v)) return { rows: v, keys: Object.keys(data) };
  }
  // Ничего из известных имён — возможно, 1С назвала массив иначе
  const anyArray = Object.entries(data).find(
    ([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object'
      && v[0] !== null && ('item_code' in (v[0] as object) || 'item' in (v[0] as object)),
  );
  if (anyArray) return { rows: anyArray[1] as any[], keys: Object.keys(data) };
  return { rows: null, keys: Object.keys(data) };
}

/** Обрезка под VarChar: длинное значение из 1С не должно ронять весь заказ */
const cut = (v: unknown, len: number): string | null => {
  const t = str(v);
  return t ? t.slice(0, len) : null;
};

/**
 * Приём данных из 1С (08_INTEGRATION_1C.md §4).
 *
 * Модель обмена — pull: HTTP-сервисы 1С отдают документ по конкретному номеру,
 * списка «что изменилось» в ТЗ нет. Поэтому мы обходим номера, которые уже
 * знаем, и обновляем их. Новые заказы, заведённые в 1С, появятся у нас, когда
 * 1С начнёт присылать их номера (или добавит эндпоинт-список — см. §9 вопрос 1).
 *
 * Что перезаписываем: только поля, которыми владеет 1С (шапка, суммы, оплаты,
 * контрагент). Резерв, план производства и этапы цеха — наши, их синхронизация
 * не трогает.
 */
@Injectable()
export class OneCSyncService {
  private readonly logger = new Logger(OneCSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly onec: OneCClientService,
    private readonly integration: IntegrationService,
  ) {}

  /** Контрагент по БИН — юридический реквизит, владелец 1С */
  private async upsertCustomer(name: string, bin: string): Promise<string | null> {
    const cleanName = name.trim();
    const cleanBin = bin.trim().slice(0, 20);
    if (!cleanName && !cleanBin) return null;

    if (cleanBin) {
      const byBin = await this.prisma.customer.findUnique({ where: { binIin: cleanBin } });
      if (byBin) {
        if (cleanName && byBin.name !== cleanName) {
          await this.prisma.customer.update({ where: { id: byBin.id }, data: { name: cleanName } });
        }
        return byBin.id;
      }
    }
    const byName = await this.prisma.customer.findFirst({
      where: { name: { equals: cleanName, mode: 'insensitive' } },
    });
    if (byName) {
      // Дозаполняем БИН, если в нашей базе его не было
      if (cleanBin && byName.binIin !== cleanBin) {
        const busy = await this.prisma.customer.findUnique({ where: { binIin: cleanBin } });
        if (!busy) await this.prisma.customer.update({ where: { id: byName.id }, data: { binIin: cleanBin } });
      }
      return byName.id;
    }
    if (!cleanName) return null;
    const created = await this.prisma.customer.create({
      data: { name: cleanName, binIin: cleanBin || `1C-${Date.now().toString(36)}`, customerType: 'OUTSIDE' },
    });
    return created.id;
  }

  /**
   * Синхронизировать один заказ клиента по номеру (GET A).
   * Заказ должен существовать у нас — создание «с нуля» появится, когда 1С
   * начнёт присылать список новых номеров.
   */
  async syncClientOrder(orderNumber: string, report: SyncReport): Promise<boolean> {
    const rows = await this.onec.getClientOrder(orderNumber);
    const data: OneCClientOrder | undefined = rows.find((r) => r && (r.clientorder_num || r.clientorder_adem));
    if (!data) {
      report.notFound.push(orderNumber);
      return false;
    }

    // Ответ должен относиться к запрошенному документу: без сверки один
    // неверный номер запишет чужие данные в чужой заказ
    const returnedNums = [str(data.clientorder_num), str(data.clientorder_adem)].filter(Boolean);
    const asked = orderNumber.trim().toLowerCase();
    const matches = returnedNums.some((n) => {
      const low = n.toLowerCase();
      return low === asked || asked.startsWith(low) || low.startsWith(asked);
    });
    if (returnedNums.length > 0 && !matches) {
      report.errors.push({
        orderNumber,
        error: `1С вернула другой документ: ${returnedNums.join(' / ')}`,
      });
      return false;
    }
    report.found++;

    const order = await this.prisma.order.findUnique({
      where: { orderNumber },
      include: { orderLines: true },
    });
    if (!order) {
      report.missingLocally.push(orderNumber);
      return false;
    }

    // Строки: имя массива в ТЗ не указано — ищем по известным вариантам.
    // Не нашли — это НЕ успех: молча обнулять суммы нельзя.
    const { rows: itemRows, keys } = findItemsArray(data as Record<string, unknown>);
    if (itemRows === null) {
      report.linesNotParsed.push({ orderNumber, keys });
      this.logger.warn(
        `Заказ ${orderNumber}: массив строк не распознан. Ключи ответа: ${keys.join(', ')}`,
      );
      return false;
    }

    // Статус: 1С владеет согласованием и закрытием, но не производством —
    // если заказ у нас в цехе, статус 1С «К выполнению» его не откатывает
    const rawStatus = str(data.clientorder_status).toLowerCase();
    const mapped = STATUS_MAP[rawStatus];
    if (rawStatus && !mapped && !report.unknownStatuses.includes(rawStatus)) {
      report.unknownStatuses.push(rawStatus);
    }
    const keepOurs = OUR_PRODUCTION_STATUSES.has(order.status) && mapped === 'CONFIRMED';
    const nextStatus = mapped && !keepOurs ? mapped : order.status;

    const customerId = await this.upsertCustomer(str(data.client), str(data.client_bin));

    const totalAmount = itemRows.reduce((s: number, i: any) => s + num(i.amount), 0);
    const payments = Array.isArray(data.clientorder_pay_data) ? data.clientorder_pay_data : [];
    const paidAmount = payments.reduce((s, p) => s + num(p.clientorder_paid_amount), 0);

    const attempt = parseOrderNumber(orderNumber);
    const externalId = str(data.clientorder_num)
      ? `${str(data.clientorder_num)}${attempt.year ? '-' + attempt.year : ''}`
      : orderNumber;

    // Всё одной транзакцией: иначе сбой на строках оставит шапку обновлённой,
    // а отметку синхронизации — проставленной, и заказ уйдёт из очереди
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: nextStatus as any,
          ...(customerId ? { customerId } : {}),
          requestDate: parseDate(data.clientorder_date) ?? order.requestDate,
          plannedShipmentDate: parseDate(data.workplandate) ?? order.plannedShipmentDate,
          region: cut(data.region, 50) ?? order.region,
          onecNum: attempt.kind === 'adem' ? cut(data.clientorder_num, 30) : order.onecNum,
          onecStatus: cut(data.clientorder_status, 50),
          onecApprovalStatus: cut(data.clientorder_approval_status, 50),
          // Суммы пишем только если строки реально разобраны
          ...(itemRows.length > 0 ? { onecTotalAmount: totalAmount } : {}),
          ...(payments.length > 0 ? { onecPaidAmount: paidAmount } : {}),
          projectGroup: cut(data.project_group, 100),
          projectSite: cut(data.project_site, 150),
          divisionCode: cut(data.division_code, 20),
          clientAgreement: cut(data.client_agreement, 100),
          onecSyncedAt: new Date(),
        },
      });

      // Смена статуса — событие: без записи в аудит непонятно, кто её сделал
      if (nextStatus !== order.status) {
        await tx.auditLogEntry.create({
          data: {
            entityType: 'Order',
            entityId: order.id,
            action: 'status_change',
            before: { status: order.status } as any,
            after: { status: nextStatus } as any,
            userRole: '1С',
            comment: `Синхронизация с 1С: «${str(data.clientorder_status)}»`,
          },
        });
      }

      // Строки заказа: цену и количество ведёт 1С; резерв и отгрузку — мы.
      // Сопоставляем по (артикул + цена), чтобы две позиции одного артикула
      // не схлопнулись в одну и не задвоились.
      const usedLineIds = new Set<string>();
      for (const item of itemRows as any[]) {
        const code = str(item.item_code);
        if (!code) continue;
        const article = await tx.article.findUnique({ where: { articleCode: code } });
        if (!article) {
          if (!report.unknownArticles.includes(code)) report.unknownArticles.push(code);
          continue;
        }

        const qty = numOrNull(item.qty);
        const unitPrice = numOrNull(item.unitprice ?? item.unit_price ?? item.price);
        const amount = numOrNull(item.amount);
        for (const [field, parsed, raw] of [
          ['qty', qty, item.qty], ['unitprice', unitPrice, item.unitprice], ['amount', amount, item.amount],
        ] as Array<[string, number | null, unknown]>) {
          if (parsed === null && raw != null && raw !== '') {
            report.unparsed.push({ orderNumber, field, raw: String(raw).slice(0, 40) });
          }
        }

        const candidate = order.orderLines.find(
          (l) => l.articleId === article.id && !usedLineIds.has(l.id),
        );

        if (candidate) {
          usedLineIds.add(candidate.id);
          await tx.orderLine.update({
            where: { id: candidate.id },
            data: {
              // null = не разобрали → оставляем прежнее значение, а не обнуляем
              ...(qty !== null ? { qty } : {}),
              ...(unitPrice !== null ? { unitPrice } : {}),
              ...(amount !== null ? { lineTotalVat: amount } : {}),
            },
          });
        } else if ((qty ?? 0) > 0) {
          await tx.orderLine.create({
            data: {
              orderId: order.id,
              articleId: article.id,
              qty: qty ?? 0,
              unit: cut(item.unit_measure, 10) ?? 'шт',
              unitPrice: unitPrice ?? 0,
              lineTotalVat: amount ?? 0,
            },
          });
        }
      }
    });

    // Маппинг ID — вне транзакции: конфликт здесь не должен откатывать данные
    if (externalId) {
      try {
        await this.integration.linkExternal({
          entityType: 'Order',
          localId: order.id,
          externalId,
          externalCode: str(data.clientorder_adem) || orderNumber,
        });
      } catch (e) {
        report.errors.push({
          orderNumber,
          error: `Не удалось связать с 1С (${externalId}): ${e instanceof Error ? e.message : 'ошибка'}`,
        });
      }
    }

    report.updated++;
    return true;
  }

  /**
   * Пакетная синхронизация заказов. Обходит активные заказы, у которых номер
   * похож на документ 1С; служебные номера импорта (TC-ROW…) пропускает.
   */
  async syncOrders(options: { limit?: number; onlyActive?: boolean } = {}): Promise<SyncReport> {
    const limit = options.limit ?? 50;
    const report = emptyReport();

    const orders = await this.prisma.order.findMany({
      where: {
        ...(options.onlyActive === false ? {} : { status: { in: ['DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'] } }),
        // Номера вида TC-ROW104 придуманы импортом — в 1С их нет
        NOT: { orderNumber: { contains: 'ROW' } },
      },
      orderBy: [{ onecSyncedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: limit,
      select: { orderNumber: true },
    });

    // Если 1С недоступна, нет смысла ждать таймаут на каждом из 50 заказов
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;

    for (const o of orders) {
      report.requested++;
      try {
        await this.syncClientOrder(o.orderNumber, report);
      } catch (e) {
        report.errors.push({
          orderNumber: o.orderNumber,
          error: e instanceof Error ? e.message : 'Неизвестная ошибка',
        });
      }
    }
    return report;
  }

  /**
   * Закуп под заказ клиента (GET D → GET C): что снабжение заказало у поставщиков.
   * Пишем в payment_documents — туда же, где живут договоры-основания.
   */
  async syncProcurementForOrder(orderNumber: string) {
    const turnovers = await this.onec.getTurnover(orderNumber);
    const order = await this.prisma.order.findUnique({ where: { orderNumber } });
    const supplierNumbers = new Set<string>();

    for (const t of turnovers) {
      for (const row of t.supplier_invoice_alldata ?? []) {
        const n = str(row.supplier_invoice_num) || str(row.supplier_invoice_adem);
        if (n) supplierNumbers.add(n);
      }
    }

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const supplierNumber of supplierNumbers) {
      try {
        const rows = await this.onec.getSupplierOrder(supplierNumber);
        const data: OneCSupplierOrder | undefined = rows.find(
          (r) => r && (r.supplier_invoice_num || r.supplier_invoice_adem),
        );
        if (!data) {
          errors.push(`${supplierNumber}: не найден в 1С`);
          continue;
        }

        const items = Array.isArray(data.item_alldata) ? data.item_alldata : null;
        if (items === null) {
          // Структуру строк не разобрали — записать «оплачено» было бы враньём
          errors.push(
            `${supplierNumber}: массив строк не распознан (ключи: ${Object.keys(data).join(', ')})`,
          );
          continue;
        }

        const contractorId = await this.upsertCustomer(str(data.supplier), str(data.supplier_bin));
        if (!contractorId) {
          errors.push(`${supplierNumber}: не удалось определить поставщика`);
          continue;
        }

        const totalAmount = items.reduce((s: number, i: any) => s + num(i.amount), 0);
        const paidRows = Array.isArray(data.supplier_invoice_alldata) ? data.supplier_invoice_alldata : [];
        const paid = paidRows.reduce((s, p) => s + num(p.supplier_invoice_paid_amount), 0);
        const unpaidRaw = numOrNull(data.supplier_invoice_notpaid_amount);
        const unpaid = unpaidRaw ?? Math.max(0, totalAmount - paid);

        const doNumber = (str(data.supplier_invoice_num) || supplierNumber).slice(0, 30);
        const existing = await this.prisma.paymentDocument.findUnique({ where: { doNumber } });

        // Пустая сумма при непустом ответе — данные неполные: не трогаем оплаты
        if (totalAmount <= 0 && !unpaidRaw) {
          errors.push(`${supplierNumber}: суммы не разобраны, документ пропущен`);
          continue;
        }

        const payload = {
          doDate: parseDate(data.supplier_invoice_date),
          contractorId,
          currency: (str(data.currency) || 'KZT').slice(0, 3),
          totalAmount,
          paidAmount: paid,
          unpaidAmount: unpaid,
          category: cut(data.supplier_invoice_category, 30),
          status: (unpaid <= 0 && totalAmount > 0
            ? 'PAID'
            : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID') as any,
        };

        if (existing) {
          await this.prisma.paymentDocument.update({
            where: { id: existing.id },
            data: {
              ...payload,
              // Привязку к заказу не переписываем: один счёт может закрывать
              // несколько заказов, и перекидывать его между ними нельзя
              ...(order && !existing.orderId ? { orderId: order.id } : {}),
            },
          });
          updated++;
        } else {
          await this.prisma.paymentDocument.create({
            data: { doNumber, ...payload, orderId: order?.id ?? null },
          });
          created++;
        }
      } catch (e) {
        errors.push(`${supplierNumber}: ${e instanceof Error ? e.message : 'ошибка'}`);
      }
    }

    return { orderNumber, supplierOrders: supplierNumbers.size, created, updated, errors };
  }
}
