import { Controller, Get, Post, Param, Query, Body, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Resource } from '../../common/decorators/resource.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockPaymentDocuments, getMockReceivables } from '../../common/mock-data';

@ApiTags('Finance - Payment Documents')
@ApiBearerAuth()
@Resource('payment')
@Controller('payment-documents')
export class PaymentDocumentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List payment documents' })
  async findAll(@Query() query: { status?: string; customerId?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.customerId) where.contractorId = query.customerId;

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.paymentDocument.findMany({
            where, skip, take: pageSize,
            orderBy: { doDate: 'desc' },
            include: { contractor: true, order: true },
          }),
          this.prisma.paymentDocument.count({ where }),
        ]);

        return { data, meta: { page, pageSize, total } };
      },
      () => getMockPaymentDocuments(page, pageSize),
    );
  }

  @Get('receivables')
  @ApiOperation({ summary: 'Get receivables summary' })
  async getReceivables() {
    return runWithFallback(
      this.prisma,
      async () => {
        const docs = await this.prisma.paymentDocument.findMany({
          where: { status: { not: 'PAID' as any } },
          include: { contractor: true },
          take: 100,
        });

        return docs.map(d => ({
          id: d.id,
          customer: d.contractor?.name,
          docNumber: d.doNumber,
          totalAmount: Number(d.totalAmount),
          paidAmount: Number(d.paidAmount),
          balanceDue: Number(d.totalAmount) - Number(d.paidAmount),
          status: d.status,
          doDate: d.doDate,
        }));
      },
      () => getMockReceivables(),
    );
  }

  /**
   * Сверка «заказ ↔ ДО» (Этап 5): в исходной книге это ручной свод
   * «Долги 2019-2025» — здесь считается по v_customer_debts.
   * ДО исторически не привязаны к заказам, поэтому сверяем по заказчику:
   * долг по заказам (balance_due) против неоплаченного по ДО (unpaid).
   */
  @Get('reconciliation')
  @Roles('accountant', 'director', 'sales_manager', 'admin')
  @ApiOperation({ summary: 'Сверка долгов: заказы ↔ договоры-основания по заказчикам' })
  async reconciliation() {
    return runWithFallback(
      this.prisma,
      async () => {
        const rows = await this.prisma.$queryRaw<Array<{
          customer_id: string; customer_name: string; total_orders: bigint;
          total_payment_docs: bigint; total_balance_due: number;
          total_unpaid_amount: number; total_paid_amount: number;
        }>>`
          SELECT customer_id, customer_name, total_orders, total_payment_docs,
                 total_balance_due, total_unpaid_amount, total_paid_amount
          FROM v_customer_debts
          WHERE total_orders > 0 AND (total_balance_due > 0 OR total_unpaid_amount > 0)`;

        const customers = rows.map((r) => {
          const balanceDue = Number(r.total_balance_due);
          const unpaidDo = Number(r.total_unpaid_amount);
          return {
            customerId: r.customer_id,
            customerName: r.customer_name,
            ordersCount: Number(r.total_orders),
            paymentDocsCount: Number(r.total_payment_docs),
            balanceDueOrders: balanceDue,
            unpaidByDo: unpaidDo,
            paidByDo: Number(r.total_paid_amount),
            discrepancy: Math.round((balanceDue - unpaidDo) * 100) / 100,
          };
        }).sort((a, b) => Math.abs(b.discrepancy) - Math.abs(a.discrepancy));

        // Отгружено/закрыто без единого ДО — риск из исходной таблицы
        const shippedWithoutDo = await this.prisma.order.count({
          where: {
            status: { in: ['SHIPPED', 'CLOSED'] },
            paymentDocuments: { none: {} },
          },
        });
        // ДО, не привязанные к заказу (историческая правда импорта)
        const docsWithoutOrder = await this.prisma.paymentDocument.count({
          where: { orderId: null },
        });

        // Закуп под заказы: сколько ДО висит на каждом заказе на продажу
        // (колонка «Заказ на продажу» листа 19.20-7п)
        const procurementByOrder = await this.prisma.$queryRaw<Array<{
          order_id: string; order_number: string; customer_name: string;
          order_total: number; procurement_total: number; procurement_unpaid: number;
          docs_count: bigint;
        }>>`
          SELECT o.id AS order_id, o.order_number, c.name AS customer_name,
                 (SELECT coalesce(sum(ol.line_total_vat), 0) FROM order_lines ol WHERE ol.order_id = o.id) AS order_total,
                 sum(pd.total_amount) AS procurement_total,
                 sum(pd.unpaid_amount) AS procurement_unpaid,
                 count(pd.id) AS docs_count
          FROM payment_documents pd
          JOIN orders o ON o.id = pd.order_id
          JOIN customers c ON c.id = o.customer_id
          GROUP BY o.id, o.order_number, c.name
          ORDER BY sum(pd.unpaid_amount) DESC, sum(pd.total_amount) DESC
          LIMIT 20`;

        const procurementAgg = await this.prisma.paymentDocument.aggregate({
          _sum: { totalAmount: true, unpaidAmount: true },
          _count: { _all: true },
        });

        return {
          customers: customers.slice(0, 50),
          orders: procurementByOrder.map((r) => ({
            orderId: r.order_id,
            orderNumber: r.order_number,
            customerName: r.customer_name,
            orderTotal: Number(r.order_total),
            procurementTotal: Number(r.procurement_total),
            procurementUnpaid: Number(r.procurement_unpaid),
            docsCount: Number(r.docs_count),
          })),
          totals: {
            customersWithDebt: customers.length,
            balanceDueOrders: Math.round(customers.reduce((s, c) => s + c.balanceDueOrders, 0) * 100) / 100,
            unpaidByDo: Number(procurementAgg._sum.unpaidAmount ?? 0),
            procurementTotal: Number(procurementAgg._sum.totalAmount ?? 0),
            docsCount: procurementAgg._count._all,
            shippedWithoutDo,
            docsWithoutOrder,
          },
        };
      },
      () => ({ customers: [], orders: [], totals: { customersWithDebt: 0, balanceDueOrders: 0, unpaidByDo: 0, procurementTotal: 0, docsCount: 0, shippedWithoutDo: 0, docsWithoutOrder: 0 } }),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get payment document by ID' })
  async findOne(@Param('id') id: string) {
    const doc = await this.prisma.paymentDocument.findUnique({
      where: { id },
      include: {
        contractor: true,
        order: true,
        batches: { include: { material: true }, orderBy: { receiptDate: 'desc' } },
        lines: { orderBy: { lineNo: 'asc' } },
        payments: { orderBy: { paymentDate: 'desc' } },
      },
    });
    if (!doc) throw new NotFoundException({ code: 'NOT_FOUND', message: `Payment document ${id} not found` });
    return doc;
  }

  @Post()
  @Roles('accountant', 'sales_manager', 'admin')
  @ApiOperation({ summary: 'Create payment document' })
  async create(@Body() body: any) {
    return this.prisma.paymentDocument.create({
      data: {
        doNumber: body.doNumber || body.docNumber,
        doDate: body.doDate ? new Date(body.doDate) : new Date(),
        contractorId: body.contractorId || body.customerId,
        totalAmount: body.totalAmount,
        orderId: body.orderId,
        category: body.category,
      },
      include: { contractor: true },
    });
  }

  @Post(':id/payments')
  @Roles('accountant', 'admin')
  @ApiOperation({ summary: 'Record payment against document' })
  async addPayment(@Param('id') id: string, @Body() body: { amount: number; paidAt?: string; reference?: string }) {
    const doc = await this.prisma.paymentDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException({ code: 'NOT_FOUND', message: `Payment document ${id} not found` });

    const newPaid = Number(doc.paidAmount) + body.amount;
    const newStatus = newPaid >= Number(doc.totalAmount) ? 'PAID' : 'PARTIALLY_PAID';

    return this.prisma.paymentDocument.update({
      where: { id },
      data: { paidAmount: newPaid, status: newStatus as any },
    });
  }
}
