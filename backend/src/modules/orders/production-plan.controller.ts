import { Controller, Get, Post, Patch, Param, Query, Body, NotFoundException, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockProductionPlan } from '../../common/mock-data';

import { STAGE_STEPS, stepKey, stageShapeError } from '../../common/production-stages';
import { RATE_UNITS } from '../../common/contractor-requests';

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
                id: true, qty: true, unit: true, articleId: true, siteCode: true,
                article: {
                  select: {
                    id: true, articleCode: true, name: true, isMaterialResale: true,
                    _count: { select: { bomItems: true, routingOperations: true } },
                  },
                },
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
              articleId: l.article?.id ?? null,
              articleCode: l.article?.articleCode ?? '—',
              articleName: l.article?.name ?? '—',
              /** Объект/БС — мастеру видно, для какой площадки изделие */
              siteCode: l.siteCode ?? null,
              // Без состава и норм отметить изготовление нельзя (правило
              // 26.08.2026). Мастер должен видеть это ДО клика, а не ловить
              // отказ, когда работа уже сделана
              missingBom: (l.article?._count.bomItems ?? 0) === 0,
              missingNorms: (l.article?._count.routingOperations ?? 0) === 0,
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
          const blocked = products.filter((p) => p.missingBom || p.missingNorms).length;
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
            /** Изделия без спецификации: их нельзя отметить, пока не заведут */
            blockedCount: blocked,
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
        const blockedProducts = rows.reduce((s, r) => s + r.blockedCount, 0);

        // Открытые заявки на подряд — на уровне ответа, а не заказа:
        // привязать заявку к заказу заранее нельзя, в этом вся её суть.
        // Мастер разносит её сам: «из ПОДР-007 на этот заказ ушло 3,2 т»
        const requests = await this.prisma.contractorRequest.findMany({
          where: { status: { in: ['SENT', 'ACCEPTED', 'ALLOCATED'] }, contractorId: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            contractor: { select: { name: true } },
            works: { select: { actualQty: true } },
          },
        });
        const openRequests = requests.map((r) => {
          const allocated = r.works.reduce((s, w) => s + Number(w.actualQty ?? 0), 0);
          const target = r.actualQty != null ? Number(r.actualQty) : (r.plannedQty != null ? Number(r.plannedQty) : null);
          return {
            id: r.id,
            number: r.number,
            routingStage: r.routingStage,
            description: r.description,
            contractorName: r.contractor?.name ?? null,
            rateType: r.rateType,
            unit: RATE_UNITS[r.rateType] ?? '',
            allocatedQty: round3(allocated),
            targetQty: target,
            remainingQty: target != null ? round3(Math.max(0, target - allocated)) : null,
            isAccepted: r.acceptedAt != null,
          };
        // Разнесённая до конца заявка мастеру больше не нужна
        }).filter((r) => r.remainingQty == null || r.remainingQty > 0);

        return {
          orders: rows,
          total: rows.length,
          totalProducts,
          doneProducts,
          waitingProducts: totalProducts - doneProducts,
          blockedProducts,
          openRequests,
        };
      },
      () => ({ orders: [], total: 0, totalProducts: 0, doneProducts: 0, waitingProducts: 0, blockedProducts: 0, openRequests: [] }),
    );
  }

  /**
   * План производства матрицей «изделие × месяц» (28.08.2026). Модель
   * ProductionPlanItem существовала с нуля строк и без единого GET —
   * в Excel этот разрез держал 59 137 формул, у нас его не было вовсе.
   *
   * Три числа на ячейку: план (вводит плановик), факт (живой, из
   * движений ГП «с производства») и потребность заказов (по плану
   * вывоза). Факт и потребность не хранятся — считаются на лету,
   * храним только то, что решил человек.
   */
  @Get('matrix')
  @ApiOperation({ summary: 'План по изделиям: план / факт / потребность по месяцам' })
  async matrix(@Query() query: { year?: string }) {
    const year = Number(query.year) || new Date().getFullYear();
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

    return runWithFallback(
      this.prisma,
      async () => {
        const [planned, releases, demands] = await Promise.all([
          this.prisma.productionPlanItem.findMany({
            where: { periodType: 'MONTH', periodKey: { in: months } },
            include: { article: { select: { id: true, articleCode: true, name: true } } },
          }),
          // Факт: выпуск ГП по месяцам
          this.prisma.finishedGoodsMovement.findMany({
            where: {
              movementType: 'FROM_PRODUCTION',
              movementDate: { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) },
            },
            select: { itemId: true, qty: true, movementDate: true },
          }),
          // Потребность: позиции активных заказов по месяцу плана вывоза
          this.prisma.orderLine.findMany({
            where: {
              articleId: { not: null },
              order: {
                status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'] },
                plannedShipmentDate: { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) },
              },
            },
            select: {
              articleId: true, qty: true,
              order: { select: { plannedShipmentDate: true } },
              article: { select: { id: true, articleCode: true, name: true, isMaterialResale: true } },
            },
          }),
        ]);

        const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        type Row = {
          article: { id: string; articleCode: string; name: string };
          cells: Record<string, { plan: number; fact: number; demand: number }>;
        };
        const rows = new Map<string, Row>();
        const rowFor = (a: { id: string; articleCode: string; name: string }) => {
          let r = rows.get(a.id);
          if (!r) {
            r = { article: a, cells: {} };
            for (const m of months) r.cells[m] = { plan: 0, fact: 0, demand: 0 };
            rows.set(a.id, r);
          }
          return r;
        };

        for (const p of planned) {
          rowFor(p.article).cells[p.periodKey].plan = Number(p.qtyToProduce);
        }
        for (const m of releases) {
          const key = monthOf(m.movementDate);
          const r = rows.get(m.itemId);
          // Факт по изделию без плана тоже показываем: цех делал то,
          // чего в плане не было — это находка, а не мусор
          if (r) r.cells[key].fact += Number(m.qty);
          else {
            const art = await this.prisma.article.findUnique({
              where: { id: m.itemId },
              select: { id: true, articleCode: true, name: true },
            });
            if (art) rowFor(art).cells[key].fact += Number(m.qty);
          }
        }
        for (const d of demands) {
          if (!d.article || d.article.isMaterialResale) continue;
          const key = monthOf(d.order.plannedShipmentDate!);
          rowFor(d.article).cells[key].demand += Number(d.qty);
        }

        const data = [...rows.values()]
          .map((r) => ({
            ...r,
            cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, {
              plan: round3(c.plan), fact: round3(c.fact), demand: round3(c.demand),
            }])),
          }))
          .sort((a, b) => a.article.articleCode.localeCompare(b.article.articleCode));
        return { year, months, data };
      },
      () => ({ year, months, data: [] }),
    );
  }

  /**
   * Ячейка плана: «в этом месяце изготовить столько». Ноль стирает
   * запись — пустая клетка честнее нуля, который читается как решение.
   */
  @Patch('matrix')
  @Roles('planner', 'admin')
  @ApiOperation({ summary: 'Задать план изделия на месяц' })
  async setPlanCell(@Body() body: { articleId: string; periodKey: string; qty: number }) {
    if (!/^\d{4}-\d{2}$/.test(body.periodKey ?? '')) {
      throw new BadRequestException({ code: 'INVALID_PERIOD', message: 'Период — в формате ГГГГ-ММ' });
    }
    const article = await this.prisma.article.findUnique({
      where: { id: body.articleId }, select: { id: true, articleCode: true },
    });
    if (!article) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${body.articleId} not found` });
    const qty = Number(body.qty);
    if (!(qty >= 0)) {
      throw new BadRequestException({ code: 'INVALID_QTY', message: 'План не может быть отрицательным' });
    }

    const where = {
      articleId_periodType_periodKey: {
        articleId: body.articleId, periodType: 'MONTH' as const, periodKey: body.periodKey,
      },
    };
    if (qty === 0) {
      await this.prisma.productionPlanItem.deleteMany({
        where: { articleId: body.articleId, periodType: 'MONTH', periodKey: body.periodKey },
      });
      return { articleCode: article.articleCode, periodKey: body.periodKey, qty: 0, cleared: true };
    }
    await this.prisma.productionPlanItem.upsert({
      where,
      create: {
        articleId: body.articleId, periodType: 'MONTH', periodKey: body.periodKey, qtyToProduce: qty,
      },
      update: { qtyToProduce: qty },
    });
    return { articleCode: article.articleCode, periodKey: body.periodKey, qty };
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
