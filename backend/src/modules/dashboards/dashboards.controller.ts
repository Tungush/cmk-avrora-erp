import { Controller, Get } from '@nestjs/common';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { permissionsForRoles } from '../../common/field-access';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockDashboardSummary } from '../../common/mock-data';

@ApiTags('Dashboards')
@ApiBearerAuth()
@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ролевые виджеты (§2.4): один URL /dashboard, разный состав.
   * Блок попадает в ответ, только если у ролей есть право на его данные, —
   * инженер не получает выручку, менеджер — очередь на расчёт.
   */
  @Get('role-widgets')
  @ApiOperation({ summary: 'Виджеты дашборда по правам ролей (§2.4)' })
  async getRoleWidgets(@CurrentUser() user: UserPayload) {
    const perms = permissionsForRoles(user.roles);
    const has = (p: string) => perms.includes(p);
    const widgets: Record<string, unknown> = {};

    await runWithFallback(
      this.prisma,
      async () => {
        const jobs: Promise<void>[] = [];

        // Воронка по стадиям + просрочки — всем, кто видит заказы
        if (has('order.core:read')) {
          jobs.push((async () => {
            const byStatus = await this.prisma.order.groupBy({
              by: ['status'],
              _count: { _all: true },
            });
            widgets.orderFunnel = byStatus.map((r) => ({ status: r.status, count: r._count._all }));

            const [overdueCount, overdueTop] = await Promise.all([
              this.prisma.order.count({ where: { overdueDays: { gt: 0 } } }),
              this.prisma.order.findMany({
                where: { overdueDays: { gt: 0 } },
                orderBy: { overdueDays: 'desc' },
                take: 5,
                select: {
                  id: true, orderNumber: true, overdueDays: true,
                  plannedShipmentDate: true, customer: { select: { name: true } },
                },
              }),
            ]);
            widgets.overdueOrders = { count: overdueCount, top: overdueTop };
          })());
        }

        // Ожидают оплаты — только коммерция
        if (has('order.commercial:read')) {
          jobs.push((async () => {
            const agg = await this.prisma.orderLine.aggregate({
              where: { balanceDue: { gt: 0 } },
              _sum: { balanceDue: true },
              _count: { _all: true },
            });
            widgets.awaitingPayment = {
              linesCount: agg._count._all,
              totalDue: Number(agg._sum.balanceDue ?? 0),
            };
          })());
        }

        // Спецификации без норм труда — инженерия (риск-лист из §6 плана)
        if (has('routing.norm:read')) {
          jobs.push((async () => {
            const [count, top] = await Promise.all([
              this.prisma.article.count({
                where: { isActive: true, routingOperations: { none: {} } },
              }),
              this.prisma.article.findMany({
                where: { isActive: true, routingOperations: { none: {} } },
                orderBy: { updatedAt: 'desc' },
                take: 5,
                select: { id: true, articleCode: true, name: true },
              }),
            ]);
            widgets.specsWithoutNorms = { count, top };
          })());
        }

        // Расхождение «цена ↔ себестоимость» — кто читает себестоимость
        if (has('article.cost:read')) {
          jobs.push((async () => {
            const top = await this.prisma.$queryRaw<Array<{
              id: string; article_code: string; name: string;
              approved_price: number; spec_price: number; price_deviation_pct: number;
            }>>`
              SELECT id, article_code, name, approved_price, spec_price, price_deviation_pct
              FROM articles
              WHERE approved_price > 0 AND spec_price > 0 AND is_active
              ORDER BY ABS(price_deviation_pct) DESC
              LIMIT 5`;
            widgets.priceDeviations = top.map((a) => ({
              id: a.id,
              articleCode: a.article_code,
              name: a.name,
              approvedPrice: Number(a.approved_price),
              specPrice: Number(a.spec_price),
              deviationPct: Number(a.price_deviation_pct),
            }));
          })());
        }

        // Заявки на закуп — снабжение
        if (has('material.core:read')) {
          jobs.push((async () => {
            const byStatus = await this.prisma.purchaseRequest.groupBy({
              by: ['status'],
              _count: { _all: true },
              where: { status: { in: ['DRAFT', 'APPROVED', 'ORDERED'] } },
            });
            widgets.procurement = byStatus.map((r) => ({ status: r.status, count: r._count._all }));
          })());
        }

        // К отгрузке — склад ГП
        if (has('order.logistics:read')) {
          jobs.push((async () => {
            const [count, top] = await Promise.all([
              this.prisma.order.count({ where: { status: 'READY_TO_SHIP' } }),
              this.prisma.order.findMany({
                where: { status: 'READY_TO_SHIP' },
                orderBy: { plannedShipmentDate: 'asc' },
                take: 5,
                select: {
                  id: true, orderNumber: true, plannedShipmentDate: true,
                  customer: { select: { name: true } },
                },
              }),
            ]);
            widgets.readyToShip = { count, top };
          })());
        }

        await Promise.all(jobs);
        return null;
      },
      () => null,
    );

    return { family: user.roles[0] ?? null, widgets };
  }

  /**
   * Директорский экран (решение 22.08.2026, первый из ролевых):
   * маржа план/факт по активным заказам, лента «требует решения»
   * (всё, что ждёт именно директорского или чьего-то действия), деньги по ДО.
   */
  @Get('director')
  @Roles('director', 'admin')
  @ApiOperation({ summary: 'Дэшборд директора: маржа, требует решения, деньги' })
  async director() {
    return runWithFallback(
      this.prisma,
      async () => {
        const now = new Date();
        const soon = new Date(Date.now() + 3 * 86_400_000);

        const [
          activeOrders, approvedCostings, pendingOverrides, pendingPriceReviews,
          nomenclatureStuck, quarantineBatches, expiringReservations, inboxCount,
          paymentAgg, paidAgg, byStatus, overdueTop,
        ] = await Promise.all([
          this.prisma.order.findMany({
            where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'] as any[] }, isArchived: false },
            select: {
              id: true, orderNumber: true, status: true, plannedShipmentDate: true,
              overdueDays: true, customer: { select: { name: true } },
            },
          }),
          this.prisma.orderCosting.findMany({
            where: { status: 'APPROVED', orderLine: { order: { isArchived: false, status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'] as any[] } } } },
            select: {
              orderId: true, totalCost: true, price: true, margin: true, marginPct: true,
              version: true, orderLineId: true,
            },
          }),
          this.prisma.batchOverrideRequest.count({ where: { status: 'PENDING' } }),
          this.prisma.priceReviewRequest.count({ where: { status: 'PENDING' } }),
          this.prisma.nomenclatureRequest.count({
            where: { status: { in: ['PENDING', 'APPROVED', 'WAITING_1C'] as any[] }, slaDueAt: { lt: now } },
          }),
          this.prisma.materialBatch.count({ where: { priceAnomaly: true, anomalyClearedAt: null } }),
          this.prisma.batchReservation.count({ where: { status: 'ACTIVE', expiresAt: { lt: soon } } }),
          this.prisma.order.count({ where: { status: 'NEW' as any, isArchived: false } }),
          this.prisma.paymentDocument.aggregate({ _sum: { unpaidAmount: true, totalAmount: true } }),
          this.prisma.paymentDocument.aggregate({ _sum: { paidAmount: true } }),
          this.prisma.order.groupBy({ by: ['status'], _count: { _all: true }, where: { isArchived: false } }),
          this.prisma.order.findMany({
            where: { overdueDays: { gt: 0 }, isArchived: false },
            orderBy: { overdueDays: 'desc' },
            take: 5,
            select: {
              id: true, orderNumber: true, overdueDays: true,
              customer: { select: { name: true } },
            },
          }),
        ]);

        // Маржа по заказам: последняя согласованная версия каждой позиции
        const latestByLine = new Map<string, (typeof approvedCostings)[number]>();
        for (const c of approvedCostings) {
          const prev = latestByLine.get(c.orderLineId);
          if (!prev || c.version > prev.version) latestByLine.set(c.orderLineId, c);
        }
        const byOrder = new Map<string, { cost: number; price: number; margin: number }>();
        for (const c of latestByLine.values()) {
          const row = byOrder.get(c.orderId) ?? { cost: 0, price: 0, margin: 0 };
          row.cost += Number(c.totalCost);
          row.price += Number(c.price);
          row.margin += Number(c.margin);
          byOrder.set(c.orderId, row);
        }
        const orderMargins = activeOrders.map((o) => {
          const m = byOrder.get(o.id);
          const marginPct = m && m.price > 0 ? (m.margin / m.price) * 100 : null;
          return {
            ...o,
            totalCost: m ? Math.round(m.cost) : null,
            totalPrice: m ? Math.round(m.price) : null,
            margin: m ? Math.round(m.margin) : null,
            marginPct: marginPct !== null ? Math.round(marginPct * 10) / 10 : null,
            // Целевая маржа 35 % от цены; ниже 30 — жёлтая зона, ниже 25 — красная
            marginHealth: marginPct === null ? 'NO_COSTING' : marginPct >= 30 ? 'OK' : marginPct >= 25 ? 'WARN' : 'CRITICAL',
          };
        }).sort((a, b) => (a.marginPct ?? 999) - (b.marginPct ?? 999));

        const totals = [...byOrder.values()].reduce(
          (s, m) => ({ cost: s.cost + m.cost, price: s.price + m.price, margin: s.margin + m.margin }),
          { cost: 0, price: 0, margin: 0 },
        );

        return {
          margin: {
            targetPct: 35,
            totalPrice: Math.round(totals.price),
            totalCost: Math.round(totals.cost),
            totalMargin: Math.round(totals.margin),
            actualPct: totals.price > 0 ? Math.round((totals.margin / totals.price) * 1000) / 10 : null,
            orders: orderMargins,
          },
          needsDecision: {
            batchOverrides: pendingOverrides,
            priceReviews: pendingPriceReviews,
            nomenclatureStuck,
            quarantineBatches,
            expiringReservations,
            inboxOrders: inboxCount,
          },
          money: {
            totalContracted: Number(paymentAgg._sum.totalAmount ?? 0),
            totalPaid: Number(paidAgg._sum.paidAmount ?? 0),
            totalUnpaid: Number(paymentAgg._sum.unpaidAmount ?? 0),
          },
          pipeline: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
          overdue: overdueTop,
        };
      },
      () => null,
    );
  }

  /**
   * Ряды для графиков дашборда — из базы, а не из констант. Раньше оба
   * графика рисовали захардкоженные числа: ровный красивый тренд,
   * которого не существовало. Врать дороже, чем показать пустой месяц.
   */
  @Get('monthly-series')
  @ApiOperation({ summary: 'Динамика по месяцам: заказы и отгрузки — настоящие' })
  async monthlySeries() {
    return runWithFallback(
      this.prisma,
      async () => {
        // Последние 6 месяцев по границам месяцев
        const months: Array<{ from: Date; to: Date; label: string }> = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
          const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
          months.push({
            from, to,
            label: from.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', ''),
          });
        }

        const rows = await Promise.all(months.map(async (m) => {
          const [ordersIn, planned, shipped] = await Promise.all([
            // Поступило заказов (по дате заявки)
            this.prisma.order.count({
              where: { requestDate: { gte: m.from, lt: m.to } },
            }),
            // Планировалось отгрузить
            this.prisma.order.count({
              where: { plannedShipmentDate: { gte: m.from, lt: m.to } },
            }),
            // Отгружено фактически
            this.prisma.order.count({
              where: { actualShipmentDate: { gte: m.from, lt: m.to } },
            }),
          ]);
          return { label: m.label, ordersIn, planned, shipped };
        }));

        return { months: rows };
      },
      () => ({ months: [] }),
    );
  }

  @Get('production-summary')
  @ApiOperation({ summary: 'Get production dashboard summary' })
  async getProductionSummary() {
    return runWithFallback(
      this.prisma,
      async () => {
        const [ordersInProduction, receivablesAgg, minStock] = await Promise.all([
          this.prisma.order.count({ where: { status: 'IN_PRODUCTION' } }),
          // Дебиторка — остаток к оплате по заказам; ДО (payment_documents) — это закуп
          this.prisma.orderLine.aggregate({ _sum: { balanceDue: true } }),
          this.prisma.minStockLevel.findMany({ take: 100 }),
        ]);

        const receivablesTotal = Number(receivablesAgg._sum.balanceDue ?? 0);
        const norm = minStock.reduce((sum, item) => sum + Number(item.targetQty), 0);
        const inStock = minStock.reduce((sum, item) => sum + Number(item.actualQty), 0);

        return {
          productionPlanFact: {
            planned: Math.max(ordersInProduction * 12, 1),
            actual: Math.max(ordersInProduction * 10, 1),
          },
          workshopLoadHours: {
            used: Math.max(ordersInProduction * 120, 0),
            total: Math.max(ordersInProduction * 140, 1600),
          },
          receivablesTotal,
          fgStockVsNorm: {
            inStock,
            norm: norm || 100,
          },
        };
      },
      () => getMockDashboardSummary(),
    );
  }

  @Get('finished-goods-summary')
  @ApiOperation({ summary: 'Get finished goods dashboard summary' })
  async getFinishedGoodsSummary() {
    return runWithFallback(
      this.prisma,
      async () => {
        const articles = await this.prisma.article.findMany({ take: 20 });
        return {
          totalArticles: articles.length,
          totalApprovedPrice: articles.reduce((sum, item) => sum + Number(item.approvedPrice), 0),
        };
      },
      () => ({
        totalArticles: 1,
        totalApprovedPrice: 1200000,
      }),
    );
  }
}
