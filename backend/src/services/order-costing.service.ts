import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ArticleCostingService } from './article-costing.service';
import { MaterialBatchService } from './material-batch.service';
import { logisticsCostOf, marginAndPrice, CostingRates } from './costing.service';
import {
  summarizeLabor, defaultStaffAssignments, LaborAssignment, StageValue,
} from '../common/labor';
import { PriceSourceValue } from '../common/material-batches';

export interface BuildCostingOptions {
  /** Как брать цену материалов; по умолчанию — FIFO по остаткам */
  priceSource?: PriceSourceValue;
  /** Точечные переопределения по материалам: своя партия, своя цена */
  materialOverrides?: Record<string, {
    priceSource?: PriceSourceValue;
    batchId?: string | null;
    explicitPrice?: number | null;
    allowAnomalies?: boolean;
  }>;
  /** Ручные коэффициенты; вместе с обязательной причиной */
  rateOverrides?: Partial<Pick<CostingRates,
    'hourlyRate' | 'logisticsPct' | 'logisticsMode' | 'logisticsFixed' | 'logisticsPerKg' |
    'utilitiesPct' | 'marginPct' | 'marginMode'>>;
  ratesReason?: string;
  note?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** Доля объёма передела — Decimal(6,4) в базе */
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Калькуляция заказа как документ (09_COSTING_AND_STAGES.md §3).
 *
 * ArticleCosting отвечает «сколько стоит Ферма Ф-200 вообще». Здесь — «сколько
 * стоит эта ферма в этом заказе, посчитанная тогда-то и по таким-то партиям».
 * Разница в том, что второе не имеет права поехать задним числом.
 */
@Injectable()
export class OrderCostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly articleCosting: ArticleCostingService,
    private readonly batches: MaterialBatchService,
  ) {}

  /**
   * Строки исполнения позиции заказа (решение 23.08.2026: «норматив молчит,
   * подряд говорит»).
   *
   * Норма изделия — всегда основа: по умолчанию весь объём каждого передела
   * делает штат, и вводить для этого нечего. Строка подряда не заменяет
   * норму, а вычитает свою долю на СВОЁМ переделе; остаток (1 − Σ доля)
   * достаётся штату автоматически — «штат 40 %» не вводит никто.
   *
   * Раньше здесь было `if (saved.length > 0) return saved`, и одна строка
   * подряда выбивала из себестоимости все прочие переделы: на DEMO-1003
   * подряд на сборке ронял труд с 652 800 ₸ до 480 000 ₸ (резка и покраска
   * исчезали молча), а при доле меньше 1 расчёт падал с INVALID_SHARES.
   */
  async assignmentsFor(orderLineId: string, articleId: string | null, hourlyRate: number): Promise<LaborAssignment[]> {
    const line = await this.prisma.orderLine.findUnique({
      where: { id: orderLineId },
      select: { orderId: true, qty: true, articleId: true },
    });

    // Подряд заводится либо на позицию, либо на заказ целиком (режим ORDER)
    const works = line
      ? await this.prisma.contractorWork.findMany({
          where: {
            OR: [
              { orderLineId },
              { orderId: line.orderId, orderLineId: null },
            ],
          },
        })
      : [];

    // Заказ-уровневая работа делится между позициями: «фикс 500 000 ₸ за
    // передел» и принятая сумма — величины абсолютные, и без разнесения
    // списались бы целиком в каждую позицию (заказ из двух позиций стоил
    // бы вдвое дороже). База разнесения — нормативные часы передела,
    // а где норм нет — количество; в последнюю очередь поровну.
    const needsAllocation = works.some((w) => w.orderLineId === null);
    const allocByStage = needsAllocation && line
      ? await this.allocationFactors(line.orderId, orderLineId)
      : null;

    const ops = articleId
      ? await this.prisma.routingOperation.findMany({
          where: { articleId },
          include: { workCenter: true },
        })
      : [];
    const staffByNorm = defaultStaffAssignments(ops.map((o) => ({
      stage: o.stage as StageValue,
      workers: Number(o.workers),
      hoursPerUnit: Number(o.hoursPerUnit),
      hourlyRate: o.workCenter ? Number(o.workCenter.hourlyRate) : hourlyRate,
      workCenterId: o.workCenterId,
    })));

    if (works.length === 0) return staffByNorm;

    const contractorRows: LaborAssignment[] = works.map((w) => ({
      id: w.id,
      stage: w.routingStage as StageValue,
      laborKind: 'CONTRACTOR',
      share: Number(w.share),
      rateType: w.rateType,
      rate: Number(w.rate),
      // Часы занимают мощность участка, только если работают у нас
      countInShopHours: w.workLocation === 'OUR_SHOP',
      plannedHours: w.plannedHours != null ? Number(w.plannedHours) : null,
      actualQty: w.actualQty != null ? Number(w.actualQty) : null,
      actualAmount: w.actualAmount != null ? Number(w.actualAmount) : null,
      // Строка на позицию принадлежит ей целиком; заказ-уровневая — долей
      allocationFactor: w.orderLineId === null
        ? allocByStage?.get(w.routingStage as StageValue) ?? 1
        : 1,
      contractorId: w.contractorId,
      workCenterId: null,
      workers: 0,
      hoursPerUnit: 0,
    }));

    const takenByStage = new Map<StageValue, number>();
    for (const r of contractorRows) {
      takenByStage.set(r.stage, (takenByStage.get(r.stage) ?? 0) + r.share);
    }

    const result: LaborAssignment[] = [];
    for (const staff of staffByNorm) {
      // Остаток объёма после подряда достаётся штату; вводить его не нужно
      const rest = round4(Math.max(0, 1 - (takenByStage.get(staff.stage) ?? 0)));
      if (rest > 0) result.push({ ...staff, share: rest });
    }
    // Подряд на переделе, для которого нормы нет вовсе, всё равно считается
    result.push(...contractorRows);
    return result;
  }

  /**
   * Какая доля заказ-уровневой работы приходится на эту позицию — по каждому
   * переделу отдельно (решение 23.08.2026, находка проверки).
   *
   * База — нормативные часы передела: позиция, которой на сборку нужно
   * 400 нормо-часов из 500 по заказу, забирает 80 % подрядной суммы.
   * Норм нет — делим по количеству, нет и его — поровну. Сумма долей по
   * позициям всегда даёт единицу, поэтому заказ не дорожает и не дешевеет.
   */
  private async allocationFactors(
    orderId: string,
    thisLineId: string,
  ): Promise<Map<StageValue, number>> {
    const lines = await this.prisma.orderLine.findMany({
      where: { orderId },
      select: { id: true, qty: true, articleId: true },
    });
    const result = new Map<StageValue, number>();
    if (lines.length <= 1) return result; // единственная позиция — вся работа её

    const articleIds = lines.map((l) => l.articleId).filter(Boolean) as string[];
    const ops = articleIds.length
      ? await this.prisma.routingOperation.findMany({
          where: { articleId: { in: articleIds } },
          select: { articleId: true, stage: true, workers: true, hoursPerUnit: true },
        })
      : [];
    const normPerUnit = new Map<string, number>();
    for (const o of ops) {
      normPerUnit.set(`${o.articleId}:${o.stage}`, Number(o.workers) * Number(o.hoursPerUnit));
    }

    for (const stage of ['CUTTING', 'ASSEMBLY', 'PAINTING'] as StageValue[]) {
      const weightOf = (l: (typeof lines)[number]) => {
        const perUnit = l.articleId ? normPerUnit.get(`${l.articleId}:${stage}`) ?? 0 : 0;
        return perUnit * Number(l.qty);
      };
      let total = lines.reduce((s, l) => s + weightOf(l), 0);
      let mine = weightOf(lines.find((l) => l.id === thisLineId)!);

      if (total <= 0) {
        // Норм на этот передел нет ни у кого — считаем по количеству
        total = lines.reduce((s, l) => s + Number(l.qty), 0);
        mine = Number(lines.find((l) => l.id === thisLineId)!.qty);
      }
      result.set(
        stage,
        total > 0 ? round4(mine / total) : round4(1 / lines.length),
      );
    }
    return result;
  }

  /**
   * Сохранённые строки исполнения не знают норм изделия — нормы живут в
   * RoutingOperation. Для почасовых ставок подмешиваем их сюда, иначе
   * трудоёмкость обнулится.
   */
  private async withNorms(assignments: LaborAssignment[], articleId: string | null): Promise<LaborAssignment[]> {
    const needsNorms = assignments.some((a) => a.rateType === 'PER_HOUR' && !a.hoursPerUnit);
    if (!needsNorms || !articleId) return assignments;

    const ops = await this.prisma.routingOperation.findMany({ where: { articleId } });
    const byStage = new Map(ops.map((o) => [o.stage as StageValue, o]));
    return assignments.map((a) => {
      if (a.rateType !== 'PER_HOUR' || a.hoursPerUnit) return a;
      const op = byStage.get(a.stage);
      return op
        ? { ...a, workers: Number(op.workers), hoursPerUnit: Number(op.hoursPerUnit) }
        : a;
    });
  }

  /**
   * Собрать новую версию калькуляции. Каждый вызов создаёт версию — прежние
   * не переписываются никогда, в этом весь смысл документа.
   */
  async build(orderLineId: string, opts: BuildCostingOptions = {}, userId?: string) {
    const line = await this.prisma.orderLine.findUnique({
      where: { id: orderLineId },
      include: { article: true, order: { select: { id: true, orderNumber: true } } },
    });
    if (!line) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Позиция заказа ${orderLineId} не найдена` });
    }
    if (opts.rateOverrides && Object.keys(opts.rateOverrides).length > 0 && !opts.ratesReason?.trim()) {
      throw new BadRequestException({
        code: 'RATES_REASON_REQUIRED',
        message: 'Ручное изменение коэффициентов требует причину — иначе через месяц никто не вспомнит, почему тут эта цифра',
      });
    }

    const baseRates = await this.articleCosting.activeRates();
    const rates: CostingRates = { ...baseRates, ...(opts.rateOverrides ?? {}) };
    const qty = Number(line.qty);
    const weightKg = line.article ? Number(line.article.weightKg) : 0;

    // ---- материалы: цена берётся из партий и запоминается со ссылкой на приход
    const bom = line.article
      ? await this.prisma.bomItem.findMany({
          where: { articleId: line.article.id },
          include: { material: true },
        })
      : [];

    const defaultSource = opts.priceSource ?? 'FIFO_STOCK';
    const materialRows = [];
    let materialCost = 0;
    let hasShortage = false;

    for (const item of bom) {
      const override = opts.materialOverrides?.[item.materialId] ?? {};
      const qtyTotal = round3(Number(item.qtyPerUnit) * qty);
      const resolution = await this.batches.priceFor(item.materialId, {
        qty: qtyTotal,
        source: override.priceSource ?? defaultSource,
        batchId: override.batchId,
        explicitPrice: override.explicitPrice,
        allowAnomalies: override.allowAnomalies,
      }, line.orderId);

      materialCost += resolution.totalCost;
      if (resolution.isShortage) hasShortage = true;

      // Стадия цены: партия прихода = факт; всё, что без партии
      // (последний закуп, прайс, ручная) — оценка. «Заказано» проставляет
      // снабжение из «Заказа поставщику» 1С отдельным действием.
      const hasBatch = Boolean(resolution.allocations[0]?.batchId);
      materialRows.push({
        materialId: item.materialId,
        materialCodeSnapshot: item.material.materialCode,
        materialNameSnapshot: item.material.name,
        qtyPerUnit: item.qtyPerUnit,
        qtyTotal,
        unitPrice: resolution.unitPrice,
        lineCost: resolution.totalCost,
        priceSource: resolution.source as any,
        batchId: resolution.allocations[0]?.batchId || null,
        priceDate: new Date(),
        allocations: resolution.allocations as any,
        isShortage: resolution.isShortage,
        shortageQty: resolution.shortageQty,
        shortageUnitPrice: resolution.shortageUnitPrice,
        priceState: (hasBatch && !resolution.isShortage ? 'ACTUAL' : 'ESTIMATE') as any,
        priceStateChangedAt: new Date(),
      });
    }
    materialCost = round2(materialCost);

    // ---- труд: штат по нормам, подряд вычитает свою долю
    const assignments = await this.withNorms(
      await this.assignmentsFor(orderLineId, line.article?.id ?? null, rates.hourlyRate),
      line.article?.id ?? null,
    );
    const labor = assignments.length > 0
      ? summarizeLabor(assignments, { qty, weightKg })
      : { lines: [], shopManHours: 0, staffCost: 0, contractorCost: 0, offsiteContractorCost: 0, totalCost: 0, byStage: [] };

    // Нормы не заведены — штатная часть посчиталась в ноль. Без этой отметки
    // заказ выглядит бесплатным по труду и при этом честным на вид
    const hasStaffLine = assignments.some((a) => a.laborKind === 'STAFF');
    const hasMissingNorm = !hasStaffLine && labor.staffCost === 0;
    // Нет состава вовсе — materialCost честный ноль, а не «дёшево»: 608
    // артикулов без BOM (25.08.2026), заказы с ними давали заниженную цену
    const hasMissingBom = Boolean(line.article) && bom.length === 0;

    // ---- коэффициенты и цена
    const logisticsCost = logisticsCostOf(materialCost, rates, { weightKg });
    const utilitiesCost = round2(materialCost * rates.utilitiesPct);
    const totalCost = round2(materialCost + labor.totalCost + logisticsCost + utilitiesCost);
    const { margin, price } = marginAndPrice(totalCost, rates);

    const previous = await this.prisma.orderCosting.findFirst({
      where: { orderLineId },
      orderBy: { version: 'desc' },
    });

    return this.prisma.orderCosting.create({
      data: {
        orderId: line.order.id,
        orderLineId,
        articleId: line.article?.id ?? null,
        qty,
        version: (previous?.version ?? 0) + 1,
        baseCostingId: previous?.id ?? null,
        createdById: userId && !userId.startsWith('usr-') ? userId : null,

        hourlyRate: rates.hourlyRate,
        logisticsPct: rates.logisticsPct,
        logisticsMode: (rates.logisticsMode ?? 'PERCENT_OF_MATERIAL') as any,
        logisticsFixed: rates.logisticsFixed ?? 0,
        logisticsPerKg: rates.logisticsPerKg ?? 0,
        utilitiesPct: rates.utilitiesPct,
        marginPct: rates.marginPct,
        marginMode: rates.marginMode as any,
        ratesSource: opts.rateOverrides && Object.keys(opts.rateOverrides).length > 0 ? 'manual' : 'config',
        ratesReason: opts.ratesReason?.trim() || null,

        materialCost,
        laborCost: labor.totalCost,
        contractorCost: labor.contractorCost,
        logisticsCost,
        utilitiesCost,
        totalCost,
        margin,
        price,
        totalManHours: labor.shopManHours,
        hasShortage,
        hasMissingNorm,
        hasMissingBom,
        note: opts.note?.trim() || null,

        materials: { create: materialRows as any },
        labor: {
          create: labor.lines.map((l, i) => ({
            stage: l.stage as any,
            laborKind: l.laborKind as any,
            workCenterId: l.workCenterId,
            contractorId: l.contractorId,
            share: l.share,
            rateType: l.rateType as any,
            rate: l.rate,
            countInShopHours: l.countedInShopHours,
            workers: assignments[i]?.workers ?? 0,
            hoursPerUnit: assignments[i]?.hoursPerUnit ?? 0,
            manHours: l.manHours,
            lineCost: l.cost,
          })),
        },
      },
      include: { materials: true, labor: true },
    });
  }

  /**
   * Согласование версии. Прежняя согласованная уходит в архив, но не удаляется:
   * по ней считались уже отданные клиенту цены.
   */
  async approve(costingId: string, userId?: string) {
    const costing = await this.prisma.orderCosting.findUnique({ where: { id: costingId } });
    if (!costing) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Калькуляция ${costingId} не найдена` });
    }
    if (costing.status === 'APPROVED') return costing;

    return this.prisma.$transaction(async (tx) => {
      await tx.orderCosting.updateMany({
        where: { orderLineId: costing.orderLineId, status: 'APPROVED' },
        data: { status: 'ARCHIVED' },
      });
      return tx.orderCosting.update({
        where: { id: costingId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedById: userId && !userId.startsWith('usr-') ? userId : null,
        },
      });
    });
  }

  async versionsOf(orderLineId: string) {
    return this.prisma.orderCosting.findMany({
      where: { orderLineId },
      orderBy: { version: 'desc' },
      include: { materials: true, labor: true },
    });
  }
}
