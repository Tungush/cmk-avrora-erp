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

const num = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

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
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }

  // «Wed May 13 2026 05:00:00 GMT+0500 (Kazakhstan Time)» — формат из ТЗ (GET C).
  // Смещение указано, поэтому берём календарную дату в поясе предприятия.
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: ONEC_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d).split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(day)));
}

export interface SyncReport {
  requested: number;
  found: number;
  updated: number;
  notFound: string[];
  unknownArticles: string[];
  unknownStatuses: string[];
  errors: Array<{ orderNumber: string; error: string }>;
}

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
    report.found++;

    const order = await this.prisma.order.findUnique({
      where: { orderNumber },
      include: { orderLines: true },
    });
    if (!order) {
      report.notFound.push(orderNumber);
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

    const items = Array.isArray(data.items) ? data.items : [];
    const totalAmount = items.reduce((s, i) => s + num(i.amount), 0);
    const payments = Array.isArray(data.clientorder_pay_data) ? data.clientorder_pay_data : [];
    const paidAmount = payments.reduce((s, p) => s + num(p.clientorder_paid_amount), 0);

    const p = parseOrderNumber(orderNumber);
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: nextStatus as any,
        ...(customerId ? { customerId } : {}),
        requestDate: parseDate(data.clientorder_date) ?? order.requestDate,
        plannedShipmentDate: parseDate(data.workplandate) ?? order.plannedShipmentDate,
        region: str(data.region) || order.region,
        // Номер 1С храним отдельно: наш orderNumber может быть «адемовским»
        onecNum: p.kind === 'adem' ? str(data.clientorder_num) || null : order.onecNum,
        onecStatus: str(data.clientorder_status) || null,
        onecApprovalStatus: str(data.clientorder_approval_status) || null,
        onecTotalAmount: totalAmount || null,
        onecPaidAmount: paidAmount || null,
        projectGroup: str(data.project_group) || null,
        projectSite: str(data.project_site) || null,
        divisionCode: str(data.division_code) || null,
        clientAgreement: str(data.client_agreement) || null,
        onecSyncedAt: new Date(),
      },
    });

    // Маппинг ID: с ним повторная выгрузка не создаст дубль
    const externalId = str(data.clientorder_num) || orderNumber;
    if (externalId) {
      await this.integration.linkExternal({
        entityType: 'Order',
        localId: order.id,
        externalId,
        externalCode: str(data.clientorder_adem) || orderNumber,
      });
    }

    // Строки заказа: цену и количество ведёт 1С; резерв и отгрузку — мы
    for (const item of items) {
      const code = str(item.item_code);
      if (!code) continue;
      const article = await this.prisma.article.findUnique({ where: { articleCode: code } });
      if (!article) {
        // Номенклатура завелась в 1С мимо нас — это сигнал, а не повод создать молча
        if (!report.unknownArticles.includes(code)) report.unknownArticles.push(code);
        continue;
      }
      const qty = num(item.qty);
      const unitPrice = num(item.unitprice);
      const amount = num(item.amount);
      const existing = order.orderLines.find((l) => l.articleId === article.id);

      if (existing) {
        await this.prisma.orderLine.update({
          where: { id: existing.id },
          data: { qty: qty || Number(existing.qty), unitPrice, lineTotalVat: amount },
        });
      } else if (qty > 0) {
        await this.prisma.orderLine.create({
          data: {
            orderId: order.id,
            articleId: article.id,
            qty,
            unit: 'шт',
            unitPrice,
            lineTotalVat: amount,
          },
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
    const report: SyncReport = {
      requested: 0, found: 0, updated: 0,
      notFound: [], unknownArticles: [], unknownStatuses: [], errors: [],
    };

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
        const data: OneCSupplierOrder | undefined = rows.find((r) => r && r.supplier_invoice_num);
        if (!data) continue;

        const contractorId = await this.upsertCustomer(str(data.supplier), str(data.supplier_bin));
        if (!contractorId) continue;

        const items = data.item_alldata ?? [];
        const totalAmount = items.reduce((s, i) => s + num(i.amount), 0);
        const paid = (data.supplier_invoice_alldata ?? [])
          .reduce((s, p) => s + num(p.supplier_invoice_paid_amount), 0);
        const unpaid = num(data.supplier_invoice_notpaid_amount) || Math.max(0, totalAmount - paid);

        const doNumber = str(data.supplier_invoice_num).slice(0, 30) || supplierNumber.slice(0, 30);
        const existing = await this.prisma.paymentDocument.findUnique({ where: { doNumber } });
        const payload = {
          doDate: parseDate(data.supplier_invoice_date),
          contractorId,
          currency: (str(data.currency) || 'KZT').slice(0, 3),
          totalAmount,
          paidAmount: paid,
          unpaidAmount: unpaid,
          category: str(data.supplier_invoice_category).slice(0, 30) || null,
          status: (unpaid <= 0 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID') as any,
          orderId: order?.id ?? null,
        };

        if (existing) {
          await this.prisma.paymentDocument.update({ where: { id: existing.id }, data: payload });
          updated++;
        } else {
          await this.prisma.paymentDocument.create({ data: { doNumber, ...payload } });
          created++;
        }
      } catch (e) {
        errors.push(`${supplierNumber}: ${e instanceof Error ? e.message : 'ошибка'}`);
      }
    }

    return { orderNumber, supplierOrders: supplierNumbers.size, created, updated, errors };
  }
}
