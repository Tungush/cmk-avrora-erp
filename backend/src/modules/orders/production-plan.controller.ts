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
   * Цех: заказы в производстве вместе с видами работ (замена канбана).
   * Заказ идёт по трём видам работ сразу — резка, сборка, покраска, —
   * а не «лежит в колонке», поэтому список с прогрессом честнее доски.
   */
  @Get('shop-floor')
  @ApiOperation({ summary: 'Цех: изделия, которые надо изготовить' })
  async shopFloor(@Query() query: { search?: string }) {
    return runWithFallback(
      this.prisma,
      async () => {
        const orders = await this.prisma.order.findMany({
          where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'] } },
          orderBy: [{ plannedShipmentDate: 'asc' }, { createdAt: 'desc' }],
          take: 500,
          include: {
            customer: { select: { name: true } },
            productionStages: { select: { orderLineId: true, status: true, actualHours: true } },
            orderLines: {
              select: {
                id: true, qty: true, unit: true, articleId: true,
                article: { select: { articleCode: true, name: true, isMaterialResale: true } },
              },
            },
            contractorWorks: {
              select: {
                id: true, routingStage: true, share: true,
                contractor: { select: { name: true } },
                acceptedAt: true,
              },
            },
          },
        });

        // Нормативные часы изделия — сумма по всем видам работ: мастеру
        // показываем «сколько это стоит по норме», не разбивая на операции
        const articleIds = [...new Set(
          orders.flatMap((o) => o.orderLines.map((l) => l.articleId).filter(Boolean)),
        )] as string[];
        const norms = articleIds.length
          ? await this.prisma.routingOperation.findMany({
              where: { articleId: { in: articleIds } },
              select: { articleId: true, workers: true, hoursPerUnit: true },
            })
          : [];
        const normByArticle = new Map<string, number>();
        for (const n of norms) {
          normByArticle.set(
            n.articleId,
            (normByArticle.get(n.articleId) ?? 0) + Number(n.workers) * Number(n.hoursPerUnit),
          );
        }

        const statusByLine = new Map<string, string>();
        const hoursByLine = new Map<string, number>();
        for (const o of orders) {
          for (const st of o.productionStages) {
            if (!st.orderLineId) continue;
            const prev = statusByLine.get(st.orderLineId);
            // DONE важнее IN_PROGRESS: одна закрывающая отметка решает
            if (st.status === 'DONE' || !prev) statusByLine.set(st.orderLineId, st.status);
            if (st.actualHours != null) {
              hoursByLine.set(st.orderLineId, Number(st.actualHours));
            }
          }
        }

        const search = query.search?.trim().toLowerCase();
        const rows = orders.map((o) => {
          // Сырьё и ТМЦ цех не изготавливает — в очередь не попадают вовсе
          const productLines = o.orderLines
            .filter((l) => l.articleId && !l.article?.isMaterialResale);
          // Одно изделие двумя строками — обычное дело в заказах 1С.
          // Без номера позиции мастер видит две одинаковые строки и не
          // понимает, какую из них он уже отметил
          const codeSeen = new Map<string, number>();
          for (const l of productLines) {
            const c = l.article?.articleCode ?? '—';
            codeSeen.set(c, (codeSeen.get(c) ?? 0) + 1);
          }
          const products = productLines
            .map((l, idx) => ({
              id: l.id,
              lineNo: idx + 1,
              isDuplicateCode: (codeSeen.get(l.article?.articleCode ?? '—') ?? 0) > 1,
              articleCode: l.article?.articleCode ?? '—',
              articleName: l.article?.name ?? '—',
              qty: Number(l.qty),
              unit: l.unit,
              status: statusByLine.get(l.id) ?? 'NOT_STARTED',
              normHours: round3((normByArticle.get(l.articleId as string) ?? 0) * Number(l.qty)),
              actualHours: hoursByLine.get(l.id) ?? null,
              // Подряд у заказа: мастер видит, что часть работ отдана на сторону
              contractors: o.contractorWorks.map((w) => ({
                name: w.contractor.name,
                sharePct: Math.round(Number(w.share) * 100),
                isAccepted: w.acceptedAt != null,
              })),
            }));
          const done = products.filter((p) => p.status === 'DONE').length;
          return {
            id: o.id,
            orderNumber: o.orderNumber,
            customerName: o.customer?.name ?? null,
            status: o.status,
            plannedShipmentDate: o.plannedShipmentDate,
            overdueDays: o.overdueDays,
            products,
            doneCount: done,
            totalProducts: products.length,
            // Позиции сырья показываем только числом — чтобы было видно,
            // что они есть, но изготавливать их не надо
            resaleCount: o.orderLines.filter((l) => l.article?.isMaterialResale).length,
          };
        })
        // Заказ без изделий (только сырьё) цеху показывать незачем
        .filter((r) => r.totalProducts > 0)
        .filter((r) => !search
          || r.orderNumber.toLowerCase().includes(search)
          || (r.customerName ?? '').toLowerCase().includes(search)
          || r.products.some((p) =>
            p.articleCode.toLowerCase().includes(search) || p.articleName.toLowerCase().includes(search)));

        const totalProducts = rows.reduce((s, r) => s + r.totalProducts, 0);
        const doneProducts = rows.reduce((s, r) => s + r.doneCount, 0);
        return {
          orders: rows,
          total: rows.length,
          totalProducts,
          doneProducts,
          waitingProducts: totalProducts - doneProducts,
        };
      },
      () => ({ orders: [], total: 0, totalProducts: 0, doneProducts: 0, waitingProducts: 0 }),
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
