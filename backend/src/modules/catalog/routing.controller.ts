import {
  Controller, Get, Put, Post, Param, Body,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Resource } from '../../common/decorators/resource.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { EventsService } from '../../services/events.service';
import { ArticleCostingService, DEFAULT_RATES } from '../../services/article-costing.service';
import { runWithFallback } from '../../common/fallback';
import {
  calculateArticleCosting, explainCosting, actualDeviationPct, costingImpact,
  StageNorm, CostingRates,
} from '../../services/costing.service';

/** Заказ считается затронутым правкой нормы, пока не отгружен и не закрыт */
const ACTIVE_ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'] as const;

const STAGES = ['CUTTING', 'ASSEMBLY', 'PAINTING'] as const;
type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  CUTTING: 'Резка',
  ASSEMBLY: 'Сборка / сварка / обшивка',
  PAINTING: 'Зачистка / покраска',
};

function assertStage(stage: string): asserts stage is Stage {
  if (!STAGES.includes(stage as Stage)) {
    throw new BadRequestException({
      code: 'INVALID_STAGE',
      message: `Неизвестный передел: ${stage}. Допустимо: ${STAGES.join(', ')}`,
    });
  }
}

/**
 * Модуль трудочасов — восстановление логики «Спецификации 2022»
 * (07_ARCHITECTURE_AND_UX.md §3). Норму пишет engineer, факт — shop_foreman.
 */
@ApiTags('Catalog - Routing (трудочасы)')
@ApiBearerAuth()
@Resource('routing')
@Controller('articles/:articleId/routing')
export class RoutingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly costingService: ArticleCostingService,
  ) {}

  private activeRates(): Promise<CostingRates> {
    return this.costingService.activeRates();
  }

  private materialCostOf(articleId: string): Promise<number> {
    return this.costingService.materialCostOf(articleId);
  }

  @Get()
  @ApiOperation({ summary: 'Нормы и факт по переделам + отклонения' })
  async getRouting(@Param('articleId') articleId: string) {
    const rates = await this.activeRates();
    const ops = await runWithFallback(
      this.prisma,
      () => this.prisma.routingOperation.findMany({
        where: { articleId },
        include: { workCenter: true },
        orderBy: { sortOrder: 'asc' },
      }),
      () => [],
    );

    // Все три передела всегда присутствуют в ответе — незаполненные с нулями,
    // чтобы UI показывал «норма не задана», а не прятал передел
    const byStage = new Map(ops.map((o: any) => [o.stage, o]));
    const stages = STAGES.map((stage) => {
      const op: any = byStage.get(stage);
      const workers = op ? Number(op.workers) : 0;
      const hours = op ? Number(op.hoursPerUnit) : 0;
      const rate = op?.workCenter ? Number(op.workCenter.hourlyRate) : rates.hourlyRate;
      const manHours = workers * hours;
      return {
        stage,
        label: STAGE_LABELS[stage],
        exists: !!op,
        workers,
        hoursPerUnit: hours,
        workCenter: op?.workCenter
          ? { id: op.workCenter.id, code: op.workCenter.code, name: op.workCenter.name, hourlyRate: rate }
          : null,
        hourlyRate: rate,
        manHours: Math.round(manHours * 1000) / 1000,
        stageCost: Math.round(manHours * rate * 100) / 100,
        actualWorkers: op?.actualWorkers != null ? Number(op.actualWorkers) : null,
        actualHours: op?.actualHours != null ? Number(op.actualHours) : null,
        actualDeviationPct: op
          ? actualDeviationPct(
              manHours,
              op.actualWorkers != null ? Number(op.actualWorkers) : null,
              op.actualHours != null ? Number(op.actualHours) : null,
            )
          : null,
        notes: op?.notes ?? null,
        updatedAt: op?.updatedAt ?? null,
      };
    });

    return { articleId, rates, stages };
  }

  @Put(':stage')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Задать норму передела (engineer)' })
  async putNorm(
    @Param('articleId') articleId: string,
    @Param('stage') stageParam: string,
    @Body() body: { workers: number; hoursPerUnit: number; workCenterId?: string; notes?: string; reason?: string },
    @CurrentUser() user: UserPayload,
  ) {
    assertStage(stageParam);
    if (!(body.workers > 0) || !(body.hoursPerUnit >= 0)) {
      throw new BadRequestException({
        code: 'INVALID_NORM',
        message: 'workers должен быть > 0, hoursPerUnit ≥ 0',
      });
    }

    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${articleId} not found` });

    // Транзакция: норма + история — правка в Excel затирала значение безвозвратно
    const op = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.routingOperation.upsert({
        where: { articleId_stage: { articleId, stage: stageParam } },
        update: {
          workers: body.workers,
          hoursPerUnit: body.hoursPerUnit,
          workCenterId: body.workCenterId ?? null,
          notes: body.notes,
          updatedById: user.userId.startsWith('usr-') ? null : user.userId,
        },
        create: {
          articleId,
          stage: stageParam,
          sortOrder: STAGES.indexOf(stageParam),
          workers: body.workers,
          hoursPerUnit: body.hoursPerUnit,
          workCenterId: body.workCenterId ?? null,
          notes: body.notes,
        },
      });
      await tx.routingOperationHistory.create({
        data: {
          operationId: saved.id,
          workers: body.workers,
          hoursPerUnit: body.hoursPerUnit,
          changedById: user.userId.startsWith('usr-') ? null : user.userId,
          reason: body.reason,
        },
      });
      return saved;
    });

    // Точечный каскад: себестоимость только этого артикула (§3.4)
    const costing = await this.recalculateInternal(articleId, 'routing_change', user);
    return { operation: op, costing };
  }

  @Post(':stage/actual')
  @Roles('shop_foreman', 'admin')
  @ApiOperation({ summary: 'Зафиксировать факт из цеха (shop_foreman)' })
  async postActual(
    @Param('articleId') articleId: string,
    @Param('stage') stageParam: string,
    @Body() body: { actualWorkers: number; actualHours: number },
  ) {
    assertStage(stageParam);
    const op = await this.prisma.routingOperation.findUnique({
      where: { articleId_stage: { articleId, stage: stageParam } },
    });
    if (!op) {
      throw new NotFoundException({
        code: 'NORM_NOT_SET',
        message: 'Норма для передела не задана — сначала инженер задаёт норму',
      });
    }
    return this.prisma.routingOperation.update({
      where: { id: op.id },
      data: { actualWorkers: body.actualWorkers, actualHours: body.actualHours },
    });
  }

  @Post(':stage/promote')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: '«Принять факт как норму» — перенос с историей' })
  async promote(
    @Param('articleId') articleId: string,
    @Param('stage') stageParam: string,
    @CurrentUser() user: UserPayload,
  ) {
    assertStage(stageParam);
    const op = await this.prisma.routingOperation.findUnique({
      where: { articleId_stage: { articleId, stage: stageParam } },
    });
    if (!op) throw new NotFoundException({ code: 'NORM_NOT_SET', message: 'Норма не задана' });
    if (op.actualWorkers == null || op.actualHours == null) {
      throw new BadRequestException({ code: 'NO_ACTUALS', message: 'Факт из цеха ещё не зафиксирован' });
    }
    return this.putNorm(
      articleId,
      stageParam,
      {
        workers: Number(op.actualWorkers),
        hoursPerUnit: Number(op.actualHours),
        workCenterId: op.workCenterId ?? undefined,
        reason: 'Факт из цеха принят как норма',
      },
      user,
    );
  }

  @Get('history')
  @ApiOperation({ summary: 'История изменения норм' })
  async history(@Param('articleId') articleId: string) {
    return runWithFallback(
      this.prisma,
      () => this.prisma.routingOperationHistory.findMany({
        where: { operation: { articleId } },
        include: { operation: { select: { stage: true } } },
        orderBy: { changedAt: 'desc' },
        take: 100,
      }),
      () => [],
    );
  }

  private recalculateInternal(articleId: string, trigger: string, user?: UserPayload) {
    return this.costingService.recalculate(articleId, trigger, user?.userId);
  }

  @Post('recalculate')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Пересчитать себестоимость артикула (точечно)' })
  async recalculate(@Param('articleId') articleId: string, @CurrentUser() user: UserPayload) {
    return this.recalculateInternal(articleId, 'manual', user);
  }

  /** Позиции этого артикула в незакрытых заказах — общий кусок для usage и preview */
  private async activeOrderLines(articleId: string) {
    return runWithFallback(
      this.prisma,
      () => this.prisma.orderLine.findMany({
        where: {
          articleId,
          order: { status: { in: ACTIVE_ORDER_STATUSES as any } },
        },
        include: { order: { include: { customer: { select: { name: true } } } } },
      }),
      () => [],
    );
  }

  @Post('costing/preview')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Предпросмотр влияния правки нормы — до сохранения (§2.3 ④)' })
  async previewCosting(
    @Param('articleId') articleId: string,
    @Body() body: { stage: string; workers: number; hoursPerUnit: number; workCenterId?: string | null },
  ) {
    assertStage(body.stage);
    const [rates, materialCost, ops, article, lines] = await Promise.all([
      this.activeRates(),
      this.materialCostOf(articleId),
      runWithFallback(
        this.prisma,
        () => this.prisma.routingOperation.findMany({ where: { articleId }, include: { workCenter: true } }),
        () => [],
      ),
      runWithFallback(
        this.prisma,
        () => this.prisma.article.findUnique({ where: { id: articleId } }),
        () => null,
      ),
      this.activeOrderLines(articleId),
    ]);

    const toNorm = (o: any): StageNorm => ({
      stage: o.stage,
      workers: Number(o.workers),
      hoursPerUnit: Number(o.hoursPerUnit),
      hourlyRate: o.workCenter ? Number(o.workCenter.hourlyRate) : null,
    });
    const currentNorms = (ops as any[]).map(toNorm);

    // Ставка предлагаемого участка — из БД; без участка — общая ставка
    const proposedCenter = body.workCenterId
      ? await runWithFallback(
          this.prisma,
          () => this.prisma.workCenter.findUnique({ where: { id: body.workCenterId! } }),
          () => null,
        )
      : null;
    const proposedNorm: StageNorm = {
      stage: body.stage as StageNorm['stage'],
      workers: Number(body.workers) || 0,
      hoursPerUnit: Number(body.hoursPerUnit) || 0,
      hourlyRate: proposedCenter ? Number((proposedCenter as any).hourlyRate) : null,
    };
    const proposedNorms = [
      ...currentNorms.filter((n) => n.stage !== body.stage),
      proposedNorm,
    ];

    const current = calculateArticleCosting(materialCost, currentNorms, rates);
    const proposed = calculateArticleCosting(materialCost, proposedNorms, rates);
    const impact = costingImpact(current, proposed);

    // Затронутые заказы: у кого при новой себестоимости маржа уходит в минус
    const orderMap = new Map<string, {
      orderId: string; orderNumber: string; customer: string | null; status: string;
      qty: number; unitPrice: number; plannedShipmentDate: Date | null;
    }>();
    for (const l of lines as any[]) {
      const key = l.orderId;
      const existing = orderMap.get(key);
      const qty = Number(l.qty);
      if (existing) {
        existing.qty += qty;
        existing.unitPrice = Math.max(existing.unitPrice, Number(l.unitPrice));
      } else {
        orderMap.set(key, {
          orderId: l.orderId,
          orderNumber: l.order.orderNumber,
          customer: l.order.customer?.name ?? null,
          status: l.order.status,
          qty,
          unitPrice: Number(l.unitPrice),
          plannedShipmentDate: l.order.plannedShipmentDate,
        });
      }
    }
    const affectedOrders = [...orderMap.values()];
    const negativeMargin = affectedOrders.filter(
      (o) => o.unitPrice > 0 && o.unitPrice < proposed.totalCost,
    );

    return {
      articleId,
      current,
      proposed,
      impact,
      affected: {
        ordersCount: affectedOrders.length,
        linesCount: (lines as any[]).length,
        totalQty: affectedOrders.reduce((s, o) => s + o.qty, 0),
        negativeMarginCount: negativeMargin.length,
        negativeMarginOrders: negativeMargin.slice(0, 10).map((o) => ({
          orderNumber: o.orderNumber,
          customer: o.customer,
          unitPrice: o.unitPrice,
          newCost: proposed.totalCost,
        })),
      },
      // Утверждённая цена прайса не меняется — только через согласование директора (§3.4)
      approvedPrice: article ? Number((article as any).approvedPrice) : null,
      approvedPriceUnchanged: true,
    };
  }

  @Get('usage')
  @ApiOperation({ summary: '«Где применяется»: позиции в активных заказах (§3.3)' })
  async usage(@Param('articleId') articleId: string) {
    const lines = await this.activeOrderLines(articleId);

    const orderMap = new Map<string, {
      orderId: string; orderNumber: string; customer: string | null; status: string;
      qty: number; plannedShipmentDate: Date | null;
    }>();
    for (const l of lines as any[]) {
      const existing = orderMap.get(l.orderId);
      const qty = Number(l.qty);
      if (existing) {
        existing.qty += qty;
      } else {
        orderMap.set(l.orderId, {
          orderId: l.orderId,
          orderNumber: l.order.orderNumber,
          customer: l.order.customer?.name ?? null,
          status: l.order.status,
          qty,
          plannedShipmentDate: l.order.plannedShipmentDate,
        });
      }
    }

    const orders = [...orderMap.values()].sort((a, b) => {
      if (!a.plannedShipmentDate) return 1;
      if (!b.plannedShipmentDate) return -1;
      return a.plannedShipmentDate.getTime() - b.plannedShipmentDate.getTime();
    });
    const nearest = orders.find((o) => o.plannedShipmentDate) ?? null;

    return {
      articleId,
      ordersCount: orders.length,
      linesCount: (lines as any[]).length,
      totalQty: orders.reduce((s, o) => s + o.qty, 0),
      nearestShipment: nearest
        ? { orderNumber: nearest.orderNumber, date: nearest.plannedShipmentDate }
        : null,
      orders: orders.slice(0, 20),
    };
  }

  @Get('costing/history')
  @ApiOperation({ summary: 'Снимки калькуляции во времени (§3.5)' })
  async costingHistory(@Param('articleId') articleId: string) {
    return runWithFallback(
      this.prisma,
      () => this.prisma.articleCosting.findMany({
        where: { articleId },
        orderBy: { calculatedAt: 'desc' },
        take: 50,
      }),
      () => [],
    );
  }

  @Get('costing')
  @ApiOperation({ summary: 'Калькуляция + разбор формулы для UI' })
  async costing(@Param('articleId') articleId: string) {
    const [rates, materialCost, ops, article] = await Promise.all([
      this.activeRates(),
      this.materialCostOf(articleId),
      runWithFallback(
        this.prisma,
        () => this.prisma.routingOperation.findMany({ where: { articleId }, include: { workCenter: true } }),
        () => [],
      ),
      runWithFallback(
        this.prisma,
        () => this.prisma.article.findUnique({ where: { id: articleId } }),
        () => null,
      ),
    ]);

    const norms: StageNorm[] = (ops as any[]).map((o) => ({
      stage: o.stage,
      workers: Number(o.workers),
      hoursPerUnit: Number(o.hoursPerUnit),
      hourlyRate: o.workCenter ? Number(o.workCenter.hourlyRate) : null,
    }));

    const result = calculateArticleCosting(materialCost, norms, rates);
    const approvedPrice = article ? Number((article as any).approvedPrice) : null;
    return {
      articleId,
      result,
      explain: explainCosting(result, approvedPrice),
    };
  }
}

@ApiTags('Catalog - Work centers')
@ApiBearerAuth()
@Controller('work-centers')
export class WorkCentersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Участки со ставками' })
  async findAll() {
    return runWithFallback(
      this.prisma,
      () => this.prisma.workCenter.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } }),
      () => [
        { id: 'wc-cut', code: 'CUT-1', name: 'Резка-1', stage: 'CUTTING', hourlyRate: 2040, capacityPerDay: 16 },
        { id: 'wc-asm', code: 'ASM-1', name: 'Сварка-1', stage: 'ASSEMBLY', hourlyRate: 2040, capacityPerDay: 24 },
        { id: 'wc-pnt', code: 'PNT-1', name: 'Покраска-1', stage: 'PAINTING', hourlyRate: 2040, capacityPerDay: 16 },
      ],
    );
  }
}

@ApiTags('Costing config')
@ApiBearerAuth()
@Resource('costingConfig')
@Controller('costing-config')
export class CostingConfigController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Активные коэффициенты калькуляции' })
  async active() {
    return runWithFallback(
      this.prisma,
      async () => {
        const cfg = await this.prisma.costingConfig.findFirst({
          where: { validTo: null },
          orderBy: { validFrom: 'desc' },
        });
        return cfg ?? { ...DEFAULT_RATES, vatPct: 0.12, paymentTermDays: 30, source: 'default' };
      },
      () => ({ ...DEFAULT_RATES, vatPct: 0.12, paymentTermDays: 30, source: 'default' }),
    );
  }

  @Put()
  @Roles('admin')
  @ApiOperation({ summary: 'Новая версия коэффициентов (admin, версионируется)' })
  async update(
    @Body() body: {
      hourlyRate: number; logisticsPct: number; utilitiesPct: number;
      vatPct: number; marginPct: number; paymentTermDays?: number;
    },
    @CurrentUser() user: UserPayload,
  ) {
    // Версия: старая закрывается validTo, новая открывается — история сохраняется
    return this.prisma.$transaction(async (tx) => {
      await tx.costingConfig.updateMany({
        where: { validTo: null },
        data: { validTo: new Date() },
      });
      return tx.costingConfig.create({
        data: {
          validFrom: new Date(),
          hourlyRate: body.hourlyRate,
          logisticsPct: body.logisticsPct,
          utilitiesPct: body.utilitiesPct,
          vatPct: body.vatPct,
          marginPct: body.marginPct,
          paymentTermDays: body.paymentTermDays ?? 30,
          createdById: user.userId.startsWith('usr-') ? null : user.userId,
        },
      });
    });
  }
}
