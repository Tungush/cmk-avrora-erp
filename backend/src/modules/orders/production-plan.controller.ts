import { Controller, Get, Post, Patch, Param, Query, Body, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockProductionPlan } from '../../common/mock-data';

const STAGE_CODES = [
  'OS_WITH_CUSTOMER', 'GENERAL_VIEW', 'DRAWINGS', 'PROCUREMENT',
  'CUTTING', 'WELDING_ASSEMBLY', 'PAINTING', 'CLADDING',
] as const;

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
   * Заказ проходит все 8 этапов одновременно, а не «лежит в колонке» —
   * поэтому список с прогрессом честнее доски.
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
            orderLines: { select: { qty: true, article: { select: { articleCode: true, name: true } } } },
          },
        });

        const rows = orders.map((o) => {
          const byCode = new Map(o.productionStages.map((s) => [s.stageCode, s.status]));
          const stages = STAGE_CODES.map((code) => ({
            code,
            status: (byCode.get(code as any) ?? 'NOT_STARTED') as string,
          }));
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
            stages,
            doneCount: done,
            totalStages: stages.length,
            currentStage: current?.code ?? null,
          };
        });

        const filtered = query.stage
          ? rows.filter((r) => r.currentStage === query.stage)
          : rows;

        // Где стоит работа: сколько заказов ждёт на каждом этапе — узкие места цеха
        const byStage = STAGE_CODES.map((code) => ({
          code,
          count: rows.filter((r) => r.currentStage === code).length,
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
