import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../services/prisma.service';
import { IntegrationService } from '../../services/integration.service';
import {
  OneCClientService, OneCClientOrder, OneCSupplierOrder, parseOrderNumber,
} from '../../services/onec-client.service';
import { MaterialReceiptService } from '../../services/material-receipt.service';
import { normalizeName } from '../../common/nomenclature';

/** Статусы 1С → наши. Незнакомый статус не двигает заказ, а попадает в отчёт. */
// Ключи — без пробелов: реальная 1С пишет статусы слитно («КОтгрузке»,
// «КОбеспечению»), ТЗ — раздельно; сравниваем после удаления пробелов.
const STATUS_MAP: Record<string, string> = {
  'насогласовании': 'DRAFT',
  'несогласован': 'DRAFT',
  'квыполнению': 'CONFIRMED',
  'кобеспечению': 'CONFIRMED', // снабжение — этап до производства
  'вработе': 'IN_PRODUCTION',
  'котгрузке': 'READY_TO_SHIP',
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
  /** Создано как NEW: заказ 1С, которого у нас не было, — ушёл в инбокс */
  createdAsNew?: number;
}

export function emptyReport(): SyncReport {
  return {
    requested: 0, found: 0, updated: 0,
    notFound: [], missingLocally: [], linesNotParsed: [], unparsed: [],
    unknownArticles: [], unknownStatuses: [], errors: [],
  };
}

/** Массив строк номенклатуры. Фактически (10.10.10.81, GET A и GET B) 1С отдаёт
 *  его в item_details — причём НЕ массивом, а строкой с вложенным JSON. Прочие
 *  имена оставлены: ТЗ поле не называет, у другой публикации может отличаться. */
const ITEM_ARRAY_KEYS = ['item_details', 'items', 'item_alldata', 'item_data', 'itemdata', 'lines', 'nomenclature'];

/** Значение поля как массив: принимаем и настоящий массив, и JSON в строке */
function asRowArray(v: unknown): any[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t.startsWith('[')) return null;
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null; // битый JSON внутри строки — уйдёт в linesNotParsed
    }
  }
  return null;
}

function findItemsArray(data: Record<string, unknown>): { rows: any[] | null; keys: string[] } {
  for (const key of ITEM_ARRAY_KEYS) {
    const rows = asRowArray(data[key]);
    if (rows) return { rows, keys: Object.keys(data) };
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
    private readonly receipts: MaterialReceiptService,
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
   * Неизвестный нам заказ (рождён сделкой Б24 → документом 1С) создаётся
   * в статусе NEW и попадает в инбокс «Новые заказы» — производство
   * принимает его явно, кнопкой, после проверки позиций.
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

    let order = await this.prisma.order.findUnique({
      where: { orderNumber },
      include: { orderLines: true },
    });
    if (!order) {
      // Заказ рождён в 1С (сделка Б24) — заводим у нас в NEW, в инбокс.
      // Контрагент нужен сразу: без него запись не имеет смысла.
      const newCustomerId = await this.upsertCustomer(str(data.client), str(data.client_bin));
      if (!newCustomerId) {
        report.missingLocally.push(orderNumber);
        return false;
      }
      order = await this.prisma.order.create({
        data: {
          orderNumber,
          customerId: newCustomerId,
          orderType: 'FZ',
          status: 'NEW' as any,
        },
        include: { orderLines: true },
      });
      report.createdAsNew = (report.createdAsNew ?? 0) + 1;
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
    const rawStatus = str(data.clientorder_status).toLowerCase().replace(/\s+/g, '');
    const mapped = STATUS_MAP[rawStatus];
    if (rawStatus && !mapped && !report.unknownStatuses.includes(rawStatus)) {
      report.unknownStatuses.push(rawStatus);
    }
    // NEW не подтверждается статусом 1С: из инбокса заказ выходит только
    // явным «Принять в производство», иначе инбокс превратится в фикцию
    const keepOurs =
      (OUR_PRODUCTION_STATUSES.has(order.status) && mapped === 'CONFIRMED') ||
      (order.status === ('NEW' as any) && mapped === 'CONFIRMED');
    const nextStatus = mapped && !keepOurs ? mapped : order.status;

    const customerId = await this.upsertCustomer(str(data.client), str(data.client_bin));

    const totalAmount = itemRows.reduce((s: number, i: any) => s + num(i.amount), 0);
    // Оплаты: фактически 1С кладёт их в pay — JSON-строкой, как и item_details
    const payments = asRowArray(data.pay) ?? asRowArray(data.clientorder_pay_data) ?? [];
    const paidAmount = payments.reduce(
      (s: number, p: any) => s + num(p.clientorder_paid_amount ?? p.pay_amount ?? p.amount),
      0,
    );

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
          // Конечный заказчик: 1С его отдаёт, а мы раньше выбрасывали —
          // хотя для работы через генподрядчиков это ключевой реквизит
          finalCustomer: cut(data.final_client, 200) ?? order.finalCustomer,
          customerOrderNum: cut(data.client_po, 60) ?? order.customerOrderNum,
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
        let article = await tx.article.findUnique({ where: { articleCode: code } });
        if (!article) {
          // Решение от 2026-08-19: артикулы ведём по кодам 1С — неизвестный код
          // заводим сразу, чтобы строка заказа не терялась. Имя берём из строки
          // 1С; цену не трогаем — прайс утверждается у нас.
          article = await tx.article.create({
            data: {
              articleCode: code.slice(0, 20),
              name: str(item.item) || code,
            },
          });
          if (!report.unknownArticles.includes(code)) report.unknownArticles.push(code);
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
        ...(options.onlyActive === false ? {} : { status: { in: ['NEW', 'DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'] } }),
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
    // Номер счёта → год документа: get_c без года документ не находит,
    // а get_d год отдаёт («2 026» — с пробелом-разрядом)
    const supplierNumbers = new Map<string, string | undefined>();

    for (const t of turnovers) {
      // Реальный get_d отдаёт плоские строки: номер счёта лежит прямо в строке
      // оборота, вложенного supplier_invoice_alldata (как в ТЗ) там нет
      const rows = Array.isArray(t.supplier_invoice_alldata) && t.supplier_invoice_alldata.length > 0
        ? t.supplier_invoice_alldata
        : [t as unknown as Record<string, unknown>];
      for (const row of rows as any[]) {
        const n = str(row.supplier_invoice_num) || str(row.supplier_invoice_adem);
        if (!n) continue;
        // Год критичен: один номер счёта существует в РАЗНЫХ годах как разные
        // документы (проверено: Т7АА-000775 есть и в 2025, и в 2026). Надёжнее
        // всего год из даты документа; supplier_invoice_year («2 026») — запасной.
        const fromDate = /\.(\d{4})/.exec(str(row.supplier_invoice_date));
        const y = fromDate?.[1] ?? (str(row.supplier_invoice_year).replace(/\D/g, '') || undefined);
        if (!supplierNumbers.has(n) || y) supplierNumbers.set(n, y && y.length === 4 ? y : undefined);
      }
    }

    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    // Сырьё из позиций документов: опознано / не опознано / приходы / стадии цен
    const procurement = {
      matched: 0,
      unmatched: [] as string[],
      receiptsCreated: 0,
      rowsOrdered: 0,
      rowsActual: 0,
    };

    for (const [supplierNumber, supplierYear] of supplierNumbers) {
      try {
        // «Не найден» приходит исключением (200 + [{error}] → throw), поэтому
        // первую попытку тоже глушим и уходим в перебор годов
        let rows: OneCSupplierOrder[] = [];
        try {
          rows = await this.onec.getSupplierOrder(supplierNumber, supplierYear);
        } catch { /* попробуем другие годы */ }
        if (rows.length === 0 || !rows.some((r) => r && (r.supplier_invoice_num || r.supplier_invoice_adem))) {
          // Год из get_d не подошёл (или его не было) — перебираем соседние
          const base = new Date().getFullYear();
          for (const y of [base, base - 1, base - 2].map(String)) {
            if (y === supplierYear) continue;
            try {
              rows = await this.onec.getSupplierOrder(supplierNumber, y);
              if (rows.some((r) => r && (r.supplier_invoice_num || r.supplier_invoice_adem))) break;
            } catch { /* «не найден» за этот год — пробуем следующий */ }
          }
        }
        const data: OneCSupplierOrder | undefined = rows.find(
          (r) => r && (r.supplier_invoice_num || r.supplier_invoice_adem),
        );
        if (!data) {
          errors.push(`${supplierNumber}: не найден в 1С`);
          continue;
        }

        const items = asRowArray(data.item_alldata);
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

        // Позиции заказа поставщику: сырьё, цены, факт поступления.
        // Отсюда рождаются партии с фактической ценой — никто ничего
        // не вводит руками (решение 22.08.2026: приходы приходят из 1С).
        const applied = await this.applyProcurementItems(order?.id ?? null, doNumber, data, items);
        procurement.matched += applied.matched;
        procurement.unmatched.push(...applied.unmatched);
        procurement.receiptsCreated += applied.receiptsCreated;
        procurement.rowsOrdered += applied.rowsOrdered;
        procurement.rowsActual += applied.rowsActual;
      } catch (e) {
        errors.push(`${supplierNumber}: ${e instanceof Error ? e.message : 'ошибка'}`);
      }
    }

    return { orderNumber, supplierOrders: supplierNumbers.size, created, updated, errors, procurement };
  }

  /**
   * Позиция 1С → наш материал. Три ступени: код 1С, точное имя,
   * нормализованный алиас (§7.6) — тот самый механизм «узнаём чужие имена».
   */
  private async matchMaterial(name: string, code: string): Promise<string | null> {
    if (code) {
      const byCode = await this.prisma.material.findFirst({
        where: { materialCode: code },
        select: { id: true },
      });
      if (byCode) return byCode.id;
    }
    if (!name) return null;
    const byName = await this.prisma.material.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (byName) return byName.id;
    const byAlias = await this.prisma.materialAlias.findFirst({
      where: { normalized: normalizeName(name) },
      select: { materialId: true },
    });
    return byAlias?.materialId ?? null;
  }

  /**
   * Что делает строка заказа поставщику у нас:
   *  1) материал опознаётся (код → имя → алиас); неопознанные — в отчёт,
   *     это кандидаты на алиас или заявку, молча терять их нельзя;
   *  2) строки калькуляции этого заказа двигаются «оценка → заказано»
   *     с номером документа; цена трогается только в черновиках —
   *     согласованная версия остаётся снимком;
   *  3) если по документу есть акт (товар поступил) — создаётся приход
   *     и партия с фактической ценой; карантин аномалий срабатывает сам;
   *     строки калькуляции получают стадию «факт».
   */
  private async applyProcurementItems(
    orderId: string | null,
    doNumber: string,
    data: OneCSupplierOrder,
    items: any[],
  ) {
    const result = {
      matched: 0,
      unmatched: [] as string[],
      receiptsCreated: 0,
      rowsOrdered: 0,
      rowsActual: 0,
    };

    // Акт по документу = сырьё физически поступило; его дата — дата прихода
    const acts = Array.isArray(data.actdoc_alldata) ? data.actdoc_alldata : [];
    const actDateRaw = acts
      .map((a) => parseDate(a.actdoc_processed_date ?? a.actdoc_date))
      .filter(Boolean)
      .sort((a, b) => (a as Date).getTime() - (b as Date).getTime())[0] ?? null;
    const hasArrived = acts.length > 0;

    const costingRows = orderId
      ? await this.prisma.orderCostingMaterial.findMany({
          where: { costing: { orderId } },
          select: { id: true, materialId: true, qtyTotal: true, priceState: true, costing: { select: { status: true } } },
        })
      : [];

    for (const it of items) {
      const name = str(it.item);
      const code = str(it.item_code);
      const qty = num(it.qty);
      const unitPrice = num(it.unit_price);
      if (!(qty > 0) || !(unitPrice > 0)) continue;

      const materialId = await this.matchMaterial(name, code);
      if (!materialId) {
        result.unmatched.push(name || code || '—');
        continue;
      }
      result.matched++;

      // «Оценка → заказано»: цена уже известна из документа 1С
      for (const row of costingRows.filter((r) => r.materialId === materialId && r.priceState === 'ESTIMATE')) {
        await this.prisma.orderCostingMaterial.update({
          where: { id: row.id },
          data: {
            priceState: 'ORDERED',
            supplierOrderNumber: doNumber,
            priceStateChangedAt: new Date(),
            // Снимок согласованной версии неприкосновенен — деньги меняем только в черновике
            ...(row.costing.status === 'DRAFT'
              ? { unitPrice, lineCost: Math.round(unitPrice * Number(row.qtyTotal) * 100) / 100 }
              : {}),
          },
        });
        result.rowsOrdered++;
      }

      if (!hasArrived) continue;

      // Приход идемпотентен по (материал, документ): повторный синк
      // того же счёта не задваивает склад
      const already = await this.prisma.materialStockMovement.findFirst({
        where: { itemId: materialId, documentNumber: doNumber, movementType: 'RECEIPT' as any },
      });
      if (!already) {
        await this.receipts.receive({
          materialId,
          qty,
          unitPrice,
          movementDate: (actDateRaw ?? new Date()).toISOString(),
          supplierName: str(data.supplier) || null,
          documentNumber: doNumber,
          comment: `Заказ поставщику ${doNumber} (синхронизация 1С)`,
        } as any);
        result.receiptsCreated++;
      }

      // «Заказано → факт»: партия с фактической ценой существует
      for (const row of costingRows.filter((r) => r.materialId === materialId && r.priceState !== 'ACTUAL')) {
        await this.prisma.orderCostingMaterial.update({
          where: { id: row.id },
          data: {
            priceState: 'ACTUAL',
            supplierOrderNumber: doNumber,
            priceStateChangedAt: new Date(),
            ...(row.costing.status === 'DRAFT'
              ? { unitPrice, lineCost: Math.round(unitPrice * Number(row.qtyTotal) * 100) / 100 }
              : {}),
          },
        });
        result.rowsActual++;
      }
    }
    return result;
  }
}
