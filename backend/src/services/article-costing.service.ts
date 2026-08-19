import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { EventsService } from './events.service';
import { runWithFallback } from '../common/fallback';
import {
  calculateArticleCosting, StageNorm, CostingRates, CostingResult,
} from './costing.service';

/**
 * Фолбэк без БД. Ставка и проценты логистики/энергии — из исходника
 * («Спецификации 2022», строка 1 + «ЗП сотр.»), маржа — по решению 09 §3.2:
 * 35 % от цены вместо прежних 10 % наценки.
 */
export const DEFAULT_RATES: CostingRates = {
  hourlyRate: 2040,
  logisticsPct: 0.03,
  utilitiesPct: 0.01,
  marginPct: 0.35,
  marginMode: 'MARGIN',
  logisticsMode: 'PERCENT_OF_MATERIAL',
};

/**
 * Единый каскад пересчёта себестоимости (§3.4): что бы ни поменялось —
 * норма труда, состав (BOM) или цена материала — снимок ArticleCosting,
 * specPrice, отклонение от прайса, автозаявка директору и SSE-событие
 * пишутся в одном месте.
 */
@Injectable()
export class ArticleCostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async activeRates(): Promise<CostingRates> {
    return runWithFallback(
      this.prisma,
      async () => {
        const cfg = await this.prisma.costingConfig.findFirst({
          where: { validTo: null },
          orderBy: { validFrom: 'desc' },
        });
        if (!cfg) return DEFAULT_RATES;
        return {
          hourlyRate: Number(cfg.hourlyRate),
          logisticsPct: Number(cfg.logisticsPct),
          utilitiesPct: Number(cfg.utilitiesPct),
          marginPct: Number(cfg.marginPct),
          marginMode: cfg.marginMode,
          logisticsMode: cfg.logisticsMode,
          logisticsFixed: Number(cfg.logisticsFixed),
          logisticsPerKg: Number(cfg.logisticsPerKg),
        };
      },
      () => DEFAULT_RATES,
    );
  }

  /** Материальная часть = Σ (расход × закупочная цена) по составу */
  async materialCostOf(articleId: string): Promise<number> {
    return runWithFallback(
      this.prisma,
      async () => {
        const items = await this.prisma.bomItem.findMany({
          where: { articleId },
          include: { material: true },
        });
        return items.reduce(
          (sum, i) => sum + Number(i.qtyPerUnit) * Number(i.material.purchasePrice),
          0,
        );
      },
      () => 0,
    );
  }

  async normsOf(articleId: string): Promise<StageNorm[]> {
    const ops = await runWithFallback(
      this.prisma,
      () => this.prisma.routingOperation.findMany({ where: { articleId }, include: { workCenter: true } }),
      () => [],
    );
    return (ops as any[]).map((o) => ({
      stage: o.stage,
      workers: Number(o.workers),
      hoursPerUnit: Number(o.hoursPerUnit),
      hourlyRate: o.workCenter ? Number(o.workCenter.hourlyRate) : null,
    }));
  }

  /**
   * Точечный пересчёт одного артикула. Полный пересчёт 27 тысяч строк
   * не запускается никогда (TZ_Cascade_RBAC).
   */
  async recalculate(articleId: string, trigger: string, userId?: string): Promise<CostingResult> {
    const [rates, materialCost, norms] = await Promise.all([
      this.activeRates(),
      this.materialCostOf(articleId),
      this.normsOf(articleId),
    ]);

    const result = calculateArticleCosting(materialCost, norms, rates);
    const dbUserId = userId && !userId.startsWith('usr-') ? userId : null;

    // Снимок + specPrice — цифры прошлых периодов не «плывут» (§3.4)
    await runWithFallback(
      this.prisma,
      async () => {
        await this.prisma.articleCosting.create({
          data: {
            articleId,
            materialCost: result.materialCost,
            laborCost: result.laborCost,
            totalManHours: result.totalManHours,
            logisticsCost: result.logisticsCost,
            utilitiesCost: result.utilitiesCost,
            totalCost: result.totalCost,
            margin: result.margin,
            price: result.price,
            marginMode: result.marginMode,
            marginPct: result.marginPct,
            logisticsPct: rates.logisticsPct,
            trigger,
            triggeredById: dbUserId,
          },
        });
        const article = await this.prisma.article.findUnique({ where: { id: articleId } });
        const approved = article ? Number(article.approvedPrice) : 0;
        const deviationPct = approved > 0 && result.price > 0
          ? Math.round(((approved - result.price) / result.price) * 10000) / 100
          : 0;
        await this.prisma.article.update({
          where: { id: articleId },
          data: { specPrice: result.price, priceDeviationPct: deviationPct },
        });

        // |отклонение| > порога → задача директору на пересмотр цены (§3.4, ±5% из TZ_Cascade_RBAC)
        if (approved > 0 && Math.abs(deviationPct) > 5) {
          const pending = await this.prisma.priceReviewRequest.findFirst({
            where: { articleId, status: 'PENDING' },
          });
          if (!pending) {
            await this.prisma.priceReviewRequest.create({
              data: {
                articleId,
                calculatedPrice: result.price,
                approvedPrice: approved,
                deviationPct,
                reason: `Автоматически: отклонение прайса от расчёта ${deviationPct > 0 ? '+' : ''}${deviationPct}% при пересчёте (${trigger})`,
                requestedById: dbUserId,
              },
            });
          }
        }
        return null;
      },
      () => null,
    );

    // Живое оповещение подписчиков «Спецификаций» и «Прайса» (§3.4)
    this.events.emit('article:cost_updated', { articleId, trigger });

    return result;
  }
}
