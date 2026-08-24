import { Controller, Get, Post, Patch, Param, Query, Body, NotFoundException, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockProductionPlan } from '../../common/mock-data';

import { STAGE_STEPS, stepKey, stageShapeError } from '../../common/production-stages';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

@ApiTags('Production Plan')
@ApiBearerAuth()
@Controller('production-plan')
export class ProductionPlanController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List production stages / plan' })
  async findAll(@Query() query: { orderId?: string; status?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.orderId) where.orderId = query.orderId;
    if (query.status) where.status = query.status;

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.productionStage.findMany({
            where, skip, take: pageSize,
            include: {
              order: { include: { customer: true } },
            },
          }),
          this.prisma.productionStage.count({ where }),
        ]);

        return { data, meta: { page, pageSize, total } };
      },
      () => getMockProductionPlan(page, pageSize),
    );
  }

  /**
   * Раскладка по неделям (Этап 5, §2.2 «План + Мин. остатки + Рабочее время»):
   * агрегат активных заказов по ISO-неделе плановой отгрузки.
   * Заказы без даты не прячутся — отдельная строка «Без даты»: это реальный
   * пробел данных, который в Excel был невидим.
   */
  /**
   * Цех: заказы в производстве вместе с этапами (замена канбана).
   * Заказ идёт по пяти шагам сразу — КД, Снабжение и три передела, — а не
   * «лежит в колонке», поэтому список с прогрессом честнее доски (09 §2.1).
   */
  @Get('shop-floor')
  @ApiOperation({ summary: 'Цех: заказы в работе + прогресс по этапам' })
  async shopFloor(@Query() query: { stage?: string; status?: string }) {
    return runWithFallback(
      this.prisma,
      async () => {
        const orders = await this.prisma.order.findMany({
          where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'] } },
          orderBy: [{ overdueDays: 'desc' }, { plannedShipmentDate: 'asc' }],
          take: 200,
          include: {
            customer: { select: { name: true } },
            productionStages: true,
            orderLines: {
              select: {
                qty: true,
                articleId: true,
                article: { select: { articleCode: true, name: true } },
              },
            },
            contractorWorks: {
              include: { contractor: { select: { id: true, name: true } } },
            },
          },
        });

        // Норма часов на передел — её мастер увидит подставленной в поле
        // «часов по факту», и в типичном случае не будет вводить ничего
        const articleIds = [...new Set(
          orders.flatMap((o) => o.orderLines.map((l) => l.articleId).filter(Boolean)),
        )] as string[];
        const norms = articleIds.length
          ? await this.prisma.routingOperation.findMany({
              where: { articleId: { in: articleIds } },
              select: { articleId: true, stage: true, workers: true, hoursPerUnit: true },
            })
          : [];
        const normByArticleStage = new Map<string, number>();
        for (const n of norms) {
          normByArticleStage.set(
            `${n.articleId}:${n.stage}`,
            Number(n.workers) * Number(n.hoursPerUnit),
          );
        }

        const rows = orders.map((o) => {
          // В режиме LINE у шага несколько записей (по позициям): шаг считается
          // готовым, только когда готовы все — иначе прогресс завышается
          const byKey = new Map<string, string[]>();
          for (const s of o.productionStages) {
            const key = stepKey(s.stageCode, s.routingStage);
            byKey.set(key, [...(byKey.get(key) ?? []), s.status]);
          }
          const stages = STAGE_STEPS.map((step) => {
            const statuses = byKey.get(step.key) ?? [];
            const status = statuses.length === 0
              ? 'NOT_STARTED'
              : statuses.every((x) => x === 'DONE')
                ? 'DONE'
                : statuses.some((x) => x === 'DONE' || x === 'IN_PROGRESS')
                  ? 'IN_PROGRESS'
                  : 'NOT_STARTED';

            // Нормативные часы передела по всем позициям заказа
            const normHours = step.routingStage
              ? round3(o.orderLines.reduce((sum, l) => {
                  const perUnit = l.articleId
                    ? normByArticleStage.get(`${l.articleId}:${step.routingStage}`) ?? 0
                    : 0;
                  return sum + perUnit * Number(l.qty);
                }, 0))
              : null;

            // Уже введённый факт: если его нет, часы считаются «по норме»
            const rows = o.productionStages.filter(
              (s) => stepKey(s.stageCode, s.routingStage) === step.key,
            );
            const actualHours = rows.some((r) => r.actualHours != null)
              ? round3(rows.reduce((s, r) => s + Number(r.actualHours ?? 0), 0))
              : null;

            // Подряд на этом переделе — мастер видит, что работа уже отдана
            const works = step.routingStage
              ? o.contractorWorks
                  .filter((w) => w.routingStage === step.routingStage)
                  .map((w) => ({
                    id: w.id,
                    contractorId: w.contractorId,
                    contractorName: w.contractor.name,
                    share: Number(w.share),
                    rateType: w.rateType,
                    rate: Number(w.rate),
                    isAccepted: w.acceptedAt != null,
                    actualQty: w.actualQty != null ? Number(w.actualQty) : null,
                  }))
              : [];

            return {
              code: step.code,
              routingStage: step.routingStage,
              key: step.key,
              label: step.label,
              status,
              lineCount: statuses.length,
              normHours,
              actualHours,
              contractorWorks: works,
              // Сколько объёма осталось штату после подряда
              staffShare: works.length
                ? Math.max(0, 1 - works.reduce((s, w) => s + w.share, 0))
                : 1,
            };
          });
          const done = stages.filter((s) => s.status === 'DONE').length;
          // Текущий этап — первый незавершённый: именно там сейчас стоит работа
          const current = stages.find((s) => s.status === 'IN_PROGRESS')
            ?? stages.find((s) => s.status !== 'DONE')
            ?? null;

          return {
            id: o.id,
            orderNumber: o.orderNumber,
            customerName: o.customer?.name ?? null,
            status: o.status,
            plannedShipmentDate: o.plannedShipmentDate,
            overdueDays: o.overdueDays,
            qty: o.orderLines.reduce((s, l) => s + Number(l.qty), 0),
            articles: o.orderLines
              .map((l) => l.article?.articleCode)
              .filter(Boolean)
              .slice(0, 3),
            stageTrackingMode: o.stageTrackingMode,
            stages,
            doneCount: done,
            totalStages: stages.length,
            currentStage: current?.key ?? null,
          };
        });

        const filtered = query.stage
          ? rows.filter((r) => r.currentStage === query.stage)
          : rows;

        // Где стоит работа: сколько заказов ждёт на каждом этапе — узкие места цеха
        const byStage = STAGE_STEPS.map((step) => ({
          code: step.code,
          routingStage: step.routingStage,
          key: step.key,
          label: step.label,
          count: rows.filter((r) => r.currentStage === step.key).length,
        }));

        return { orders: filtered, byStage, total: rows.length };
      },
      () => ({ orders: [], byStage: [], total: 0 }),
    );
  }

  @Get('weekly')
  @ApiOperation({ summary: 'План по неделям: активные заказы по неделе плановой отгрузки' })
  async weekly() {
    return runWithFallback(
      this.prisma,
      async () => {
        const rows = await this.prisma.$queryRaw<Array<{
          week_start: Date | null; orders_count: bigint; total_qty: number;
          reserved_qty: number; shipped_qty: number;
        }>>`
          SELECT date_trunc('week', o.planned_shipment_date)::date AS week_start,
                 count(DISTINCT o.id) AS orders_count,
                 coalesce(sum(ol.qty), 0) AS total_qty,
                 coalesce(sum(ol.reserved_qty), 0) AS reserved_qty,
                 coalesce(sum(ol.shipped_qty), 0) AS shipped_qty
          FROM orders o
          LEFT JOIN order_lines ol ON ol.order_id = o.id
          WHERE o.status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP')
          GROUP BY 1
          ORDER BY 1 NULLS LAST`;

        const weeks = rows.map((r) => ({
          weekStart: r.week_start,
          ordersCount: Number(r.orders_count),
          totalQty: Number(r.total_qty),
          reservedQty: Number(r.reserved_qty),
          shippedQty: Number(r.shipped_qty),
          toProduce: Math.max(0, Number(r.total_qty) - Number(r.reserved_qty) - Number(r.shipped_qty)),
        }));

        return {
          weeks: weeks.filter((w) => w.weekStart !== null),
          noDate: weeks.find((w) => w.weekStart === null) ?? null,
        };
      },
      () => ({ weeks: [], noDate: null }),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get production stage by ID' })
  async findOne(@Param('id') id: string) {
    const stage = await this.prisma.productionStage.findUnique({
      where: { id },
      include: { order: { include: { customer: true, orderLines: { include: { article: true } } } } },
    });
    if (!stage) throw new NotFoundException({ code: 'NOT_FOUND', message: `Production stage ${id} not found` });
    return stage;
  }

  @Post()
  @Roles('planner', 'admin')
  @ApiOperation({ summary: 'Create production stage' })
  async create(@Body() body: any) {
    // «Снабжение / Резка» — бессмыслица, которую потом не выловить в отчётах
    const shapeError = stageShapeError(body?.stageCode, body?.routingStage);
    if (shapeError) {
      throw new BadRequestException({ code: 'INVALID_STAGE_CODE', message: shapeError });
    }
    return this.prisma.productionStage.create({ data: body, include: { order: true } });
  }

  @Patch(':id/status')
  @Roles('shop_foreman', 'planner', 'admin')
  @ApiOperation({ summary: 'Update stage status' })
  async updateStatus(@Param('id') id: string, @Body() body: { status: string }) {
    const stage = await this.prisma.productionStage.findUnique({ where: { id } });
    if (!stage) throw new NotFoundException({ code: 'NOT_FOUND', message: `Stage ${id} not found` });
    return this.prisma.productionStage.update({ where: { id }, data: { status: body.status as any } });
  }
}
