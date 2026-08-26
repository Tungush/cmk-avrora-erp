import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';

const n = (v: unknown) => Number(v ?? 0);
const DAY = 24 * 60 * 60 * 1000;

/**
 * Дашборд заказов клиента (26.08.2026, парный к дашборду закупок).
 *
 * Главная честность здесь — «Оплата неизвестна»: onecPaidAmount заполнен
 * у 75 заказов из 383, и прежний способ «долг = сумма − оплачено» молча
 * считал незаполненное нулём, раздувая долг на миллиард. Слепая зона
 * называется слепой зоной, серым, а не красным.
 */
@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders-dashboard')
export class OrdersDashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('sales_manager', 'accountant', 'director', 'admin')
  @ApiOperation({ summary: 'Дашборд заказов клиента: портфель, направления, долги, возраст' })
  async dashboard() {
    return runWithFallback(
      this.prisma,
      async () => {
        const orders = await this.prisma.order.findMany({
          where: { isArchived: false },
          include: { customer: { select: { id: true, name: true } } },
        });
        const now = Date.now();
        const active = orders.filter((o) => !['CLOSED', 'CANCELLED'].includes(o.status));

        const contractedOf = (o: (typeof orders)[number]) => n(o.onecTotalAmount);
        const paidKnown = (o: (typeof orders)[number]) => o.onecPaidAmount != null;

        const withPayment = orders.filter(paidKnown);
        const debtOrders = withPayment.filter((o) => n(o.onecTotalAmount) > n(o.onecPaidAmount));
        const unknownPayment = active.filter((o) => !paidKnown(o));

        const monthAgo = now - 30 * DAY;
        const prevMonth = now - 60 * DAY;
        const inRange = (o: (typeof orders)[number], from: number, to: number) =>
          o.requestDate && new Date(o.requestDate).getTime() > from && new Date(o.requestDate).getTime() <= to;
        const month = orders.filter((o) => inRange(o, monthAgo, now));
        const prev = orders.filter((o) => inRange(o, prevMonth, monthAgo));
        const biggest = [...month].sort((a, b) => contractedOf(b) - contractedOf(a))[0];

        const sum = (list: typeof orders, f: (o: (typeof orders)[number]) => number) =>
          list.reduce((s, o) => s + f(o), 0);

        // Разрезы по rawColumns: направление есть у всех 383, отдельного
        // поля нет — «НаправлениеДеятельности» живёт в сыром ряду 1С
        const rawOf = (o: (typeof orders)[number]): Record<string, string> =>
          (o.rawColumns as Record<string, string> | null) ?? {};
        const cut = (key: (o: (typeof orders)[number]) => string | null) => {
          const map = new Map<string, { orders: number; total: number }>();
          for (const o of orders) {
            const k = key(o)?.trim() || '__none__';
            const acc = map.get(k) ?? { orders: 0, total: 0 };
            acc.orders += 1;
            acc.total += contractedOf(o);
            map.set(k, acc);
          }
          return [...map.entries()]
            .map(([k, v]) => ({ key: k === '__none__' ? null : k, ...v }))
            .sort((a, b) => b.total - a.total);
        };

        // Закуп по направлению — для сопоставления, НЕ маржа (подпись на экране)
        const procurement = await this.prisma.paymentDocument.groupBy({
          by: ['businessDirection'],
          _sum: { totalAmount: true },
          where: { currency: 'KZT' },
        });
        const procurementByDir = Object.fromEntries(
          procurement.map((p) => [p.businessDirection ?? '—', n(p._sum.totalAmount)]),
        );

        const byCustomer = new Map<string, {
          id: string; name: string; orders: number; total: number;
          paid: number; debt: number; unknown: number;
        }>();
        for (const o of orders) {
          const acc = byCustomer.get(o.customerId) ?? {
            id: o.customerId, name: o.customer?.name ?? '—',
            orders: 0, total: 0, paid: 0, debt: 0, unknown: 0,
          };
          acc.orders += 1;
          acc.total += contractedOf(o);
          if (paidKnown(o)) {
            acc.paid += n(o.onecPaidAmount);
            acc.debt += Math.max(0, contractedOf(o) - n(o.onecPaidAmount));
          } else {
            acc.unknown += 1;
          }
          byCustomer.set(o.customerId, acc);
        }

        const ageOf = (o: (typeof orders)[number]) =>
          o.requestDate ? Math.floor((now - new Date(o.requestDate).getTime()) / DAY) : 0;
        const ageBucket = (from: number, to: number) =>
          active.filter((o) => ageOf(o) >= from && ageOf(o) < to);
        const agg = (list: typeof orders) =>
          ({ orders: list.length, amount: sum(list, contractedOf) });

        const costings = await this.prisma.orderCosting.count();
        const approvedCostings = await this.prisma.orderCosting.count({ where: { status: 'APPROVED' as any } });
        const noBomArticles = await this.prisma.article.count({
          where: { isMaterialResale: false, bomItems: { none: {} } },
        });

        return {
          kpi: {
            portfolio: { orders: active.length, amount: sum(active, contractedOf) },
            debt: {
              amount: sum(debtOrders, (o) => contractedOf(o) - n(o.onecPaidAmount)),
              orders: debtOrders.length,
              paymentKnownOrders: withPayment.length,
            },
            unknownPayment: {
              amount: sum(unknownPayment, contractedOf),
              orders: unknownPayment.length,
            },
            contractedMonth: {
              amount: sum(month, contractedOf),
              orders: month.length,
              prevAmount: sum(prev, contractedOf),
              biggest: biggest
                ? { orderNumber: biggest.orderNumber, id: biggest.id, amount: contractedOf(biggest) }
                : null,
            },
          },
          totalContracted: sum(orders, contractedOf),
          dimensions: {
            direction: cut((o) => rawOf(o)['НаправлениеДеятельности'] ?? null),
            manager: cut((o) => rawOf(o)['Менеджер'] ?? null),
            warehouse: cut((o) => rawOf(o)['Склад'] ?? null),
            customer: cut((o) => o.customer?.name ?? null),
            project: cut((o) => o.projectSite),
            region: cut((o) => o.region),
            division: cut((o) => o.divisionCode),
          },
          procurementByDir,
          customers: [...byCustomer.values()]
            .sort((a, b) => b.debt - a.debt || b.total - a.total)
            .slice(0, 12),
          ageBuckets: [
            { label: 'до 30 дней', ...agg(ageBucket(0, 30)) },
            { label: '30–90 дней', ...agg(ageBucket(30, 90)) },
            { label: '90–180 дней', ...agg(ageBucket(90, 180)) },
            { label: 'дольше 180 дней', ...agg(ageBucket(180, 100000)) },
          ],
          gaps: {
            costings, approvedCostings,
            ordersTotal: orders.length,
            noBomArticles,
            unknownPaymentOrders: unknownPayment.length,
          },
        };
      },
      () => null,
    );
  }
}
