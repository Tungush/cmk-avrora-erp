import {
  Controller, Get, Post, Delete, Param, Body,
  NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';

/** Пользователь БД или демо-вход (usr-*), которого в базе нет */
const dbUserId = (u?: UserPayload) => (u && !u.userId.startsWith('usr-') ? u.userId : null);

/**
 * Оплаты от заказчиков по заказу (28.08.2026).
 *
 * Раньше деньги клиента жили одним числом Order.onecPaidAmount «из 1С»:
 * ни списка платежей, ни ручного ввода — бухгалтер физически не мог
 * записать «клиент заплатил 500 000 ₸». Теперь платежи — строки
 * customer_payments c источником (1С-выгрузка или ручной ввод),
 * а onecPaidAmount — денормализованная сумма, которую продолжают
 * читать все дашборды.
 *
 * Про двойной счёт сказано честно: если оплату занесли руками, а потом
 * та же оплата пришла из выгрузки 1С, строки будут две. Автоматической
 * склейки нет намеренно — угадывание «та же это оплата или нет» опаснее
 * дубля, который бухгалтер видит в списке и удаляет одним кликом.
 */
@ApiTags('Customer Payments')
@ApiBearerAuth()
@Controller()
export class CustomerPaymentsController {
  constructor(private readonly prisma: PrismaService) {}

  /** onecPaidAmount = Σ всех платежей заказа — единственная точка пересчёта */
  private async recalcOrderPaid(orderId: string) {
    const agg = await this.prisma.customerPayment.aggregate({
      where: { orderId },
      _sum: { amount: true },
    });
    await this.prisma.order.update({
      where: { id: orderId },
      data: { onecPaidAmount: agg._sum.amount ?? 0 },
    });
    return Number(agg._sum.amount ?? 0);
  }

  @Get('orders/:orderId/customer-payments')
  @ApiOperation({ summary: 'Платежи заказчика по заказу' })
  async list(@Param('orderId') orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, onecTotalAmount: true, onecPaidAmount: true },
    });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${orderId} not found` });

    const payments = await this.prisma.customerPayment.findMany({
      where: { orderId },
      orderBy: { paidAt: 'desc' },
    });
    const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
    const total = order.onecTotalAmount != null ? Number(order.onecTotalAmount) : null;
    return {
      orderNumber: order.orderNumber,
      totalAmount: total,
      paidAmount: Math.round(paid * 100) / 100,
      balanceDue: total != null ? Math.round((total - paid) * 100) / 100 : null,
      data: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    };
  }

  @Post('orders/:orderId/customer-payments')
  @Roles('accountant', 'sales_manager', 'admin')
  @ApiOperation({ summary: 'Записать оплату от заказчика' })
  async create(
    @Param('orderId') orderId: string,
    @Body() body: { amount: number; paidAt?: string; reference?: string; note?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId }, select: { id: true, orderNumber: true },
    });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${orderId} not found` });

    const amount = Number(body.amount);
    if (!(amount > 0)) {
      throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'Сумма оплаты должна быть больше нуля' });
    }
    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      throw new BadRequestException({ code: 'INVALID_DATE', message: 'Дата оплаты не распознана' });
    }

    const payment = await this.prisma.customerPayment.create({
      data: {
        orderId,
        amount,
        paidAt,
        source: 'MANUAL',
        reference: body.reference?.trim() || null,
        note: body.note?.trim() || null,
        createdById: dbUserId(user),
      },
    });
    const paidTotal = await this.recalcOrderPaid(orderId);
    return { ...payment, amount: Number(payment.amount), orderPaidTotal: paidTotal };
  }

  @Delete('customer-payments/:id')
  @Roles('accountant', 'admin')
  @ApiOperation({ summary: 'Удалить оплату (только занесённую вручную)' })
  async remove(@Param('id') id: string) {
    const payment = await this.prisma.customerPayment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException({ code: 'NOT_FOUND', message: `Платёж ${id} не найден` });
    // Строки из выгрузки 1С — не наши, их правит следующая заливка.
    // Удалить можно только то, что человек занёс руками (например, дубль)
    if (payment.source !== 'MANUAL') {
      throw new ConflictException({
        code: 'ONEC_PAYMENT',
        message: 'Этот платёж пришёл из 1С — удалять его здесь нельзя, поправьте в 1С и перезалейте выгрузку',
      });
    }
    await this.prisma.customerPayment.delete({ where: { id } });
    const paidTotal = await this.recalcOrderPaid(payment.orderId);
    return { deleted: true, orderPaidTotal: paidTotal };
  }
}
