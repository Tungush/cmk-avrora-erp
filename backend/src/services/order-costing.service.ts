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

  /** Строки исполнения заказа; если их не заводили — весь объём делает штат по нормам */
  async assignmentsFor(orderLineId: string, articleId: string | null, hourlyRate: number): Promise<LaborAssignment[]> {
    const saved = await this.prisma.orderLaborAssignment.findMany({ where: { orderLineId } });
    if (saved.length > 0) {
      return saved.map((a) => ({
        id: a.id,
        stage: a.stage as StageValue,
        laborKind: a.laborKind,
        share: Number(a.share),
        rateType: a.rateType,
        rate: Number(a.rate),
        countInShopHours: a.countInShopHours,
        plannedHours: a.plannedHours != null ? Number(a.plannedHours) : null,
        contractorId: a.contractorId,
        workCenterId: a.workCenterId,
        workers: 0,
        hoursPerUnit: 0,
      }));
    }
    if (!articleId) return [];

    const ops = await this.prisma.routingOperation.findMany({
      where: { articleId },
      include: { workCenter: true },
    });
    return defaultStaffAssignments(ops.map((o) => ({
      stage: o.stage as StageValue,
      workers: Number(o.workers),
      hoursPerUnit: Number(o.hoursPerUnit),
      hourlyRate: o.workCenter ? Number(o.workCenter.hourlyRate) : hourlyRate,
      workCenterId: o.workCenterId,
    })));
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
      });

      materialCost += resolution.totalCost;
      if (resolution.isShortage) hasShortage = true;

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
      });
    }
    materialCost = round2(materialCost);

    // ---- труд: штат и подряд, доли по переделам
    const assignments = await this.withNorms(
      await this.assignmentsFor(orderLineId, line.article?.id ?? null, rates.hourlyRate),
      line.article?.id ?? null,
    );
    const labor = assignments.length > 0
      ? summarizeLabor(assignments, { qty, weightKg })
      : { lines: [], shopManHours: 0, staffCost: 0, contractorCost: 0, offsiteContractorCost: 0, totalCost: 0, byStage: [] };

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
