import { Controller, Get } from '@nestjs/common';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { permissionsForRoles } from '../../common/field-access';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
