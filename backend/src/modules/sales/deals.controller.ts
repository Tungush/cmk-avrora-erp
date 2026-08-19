import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';

@ApiTags('Sales - Deals')
@ApiBearerAuth()
@Controller('deals')
export class DealsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('sales_manager', 'accountant', 'director', 'admin')
  @ApiOperation({ summary: 'List deals' })
  async findAll(@Query() query: { source?: string; status?: string }) {
    const where: Record<string, unknown> = {};
    if (query.source) where.source = query.source;
    if (query.status) where.status = query.status;

    return this.prisma.deal.findMany({
      where,
      include: { customer: true, article: true, manager: true },
      orderBy: [{ shipmentDate: 'desc' }, { amountOrdered: 'desc' }],
    });
  }

  @Post()
  @Roles('sales_manager', 'accountant', 'admin')
  @ApiOperation({ summary: 'Create deal' })
  async create(@Body() body: Record<string, unknown>) {
    return this.prisma.deal.create({
      data: {
        source: String(body.source || 'Telecom'),
        customerId: String(body.customerId),
        articleId: body.articleId ? String(body.articleId) : null,
        managerId: body.managerId ? String(body.managerId) : null,
        qtyOrdered: Number(body.qtyOrdered || 0),
        qtyShipped: Number(body.qtyShipped || 0),
        amountOrdered: Number(body.amountOrdered || 0),
        amountPaid: Number(body.amountPaid || 0),
        status: String(body.status || 'в работе'),
        periodKey: body.periodKey ? String(body.periodKey) : null,
        shipmentDate: body.shipmentDate ? new Date(String(body.shipmentDate)) : null,
      },
      include: { customer: true, article: true, manager: true },
    });
  }

  @Patch(':id/status')
  @Roles('sales_manager', 'accountant', 'admin')
  @ApiOperation({ summary: 'Update deal status and create finished-goods expense movement on shipment' })
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string; shipmentDate?: string; amountPaid?: number; qtyShipped?: number },
    @CurrentUser() user: UserPayload,
  ) {
    const deal = await this.prisma.deal.findUnique({ where: { id } });
    if (!deal) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Deal ${id} not found` });
    }

    const nextQtyShipped = body.qtyShipped ?? Number(deal.qtyOrdered);
    const nextShipmentDate = body.shipmentDate ? new Date(body.shipmentDate) : deal.shipmentDate ?? new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedDeal = await tx.deal.update({
        where: { id },
        data: {
          status: body.status,
          shipmentDate: nextShipmentDate,
          qtyShipped: nextQtyShipped,
          amountPaid: body.amountPaid ?? deal.amountPaid,
        },
      });

      if (body.status === 'отгружено' && deal.articleId) {
        await tx.finishedGoodsMovement.create({
          data: {
            itemId: deal.articleId,
            movementType: 'EXPENSE',
            qty: nextQtyShipped,
            unitPrice: Number(deal.amountOrdered) / Math.max(Number(deal.qtyOrdered), 1),
            movementDate: nextShipmentDate,
            project: deal.source,
            sourceDocumentId: deal.id,
          },
        });
      }

      await tx.auditLogEntry.create({
        data: {
          entityType: 'Deal',
          entityId: updatedDeal.id,
          action: 'STATUS_UPDATED',
          before: { status: deal.status },
          after: {
            status: updatedDeal.status,
            qtyShipped: updatedDeal.qtyShipped,
            amountPaid: updatedDeal.amountPaid,
          },
          userId: user?.userId || null,
          userRole: user?.roles?.[0] || 'system',
          comment: body.status === 'отгружено' ? 'Shipment cascade executed' : 'Deal status updated',
        },
      });

      return updatedDeal;
    });

    return result;
  }
}
