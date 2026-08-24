import * as crypto from 'crypto';
import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
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
  @Roles('sales_manager', 'planner', 'accountant', 'director', 'admin')
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

  /**
   * Заполняющий не обязан заранее знать id — вводит имя, как в Excel.
   * Совпадение по имени (без учёта регистра) переиспользует карточку,
   * иначе заводит новую с техническим БИН — тот же приём, что при
   * заливке заказов из 1С (import-1c-csv.ts).
   */
  private async resolveCustomerId(body: Record<string, unknown>): Promise<string> {
    if (body.customerId) return String(body.customerId);
    const name = String(body.customerName ?? '').trim();
    if (!name) throw new NotFoundException({ code: 'INVALID_INPUT', message: 'Нужен заказчик: customerId или customerName' });
    const existing = await this.prisma.customer.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) return existing.id;
    const binIin = 'DL-' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 10).toUpperCase();
    const created = await this.prisma.customer.create({ data: { name, binIin, customerType: 'OUTSIDE' } });
    return created.id;
  }

  private async resolveArticleId(body: Record<string, unknown>): Promise<string | null> {
    if (body.articleId) return String(body.articleId);
    const name = String(body.articleName ?? '').trim();
    if (!name) return null;
    const existing = await this.prisma.article.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) return existing.id;
    const articleCode = 'DL-' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 10).toUpperCase();
    const created = await this.prisma.article.create({ data: { articleCode, name } });
    return created.id;
  }

  @Post()
  @Roles('sales_manager', 'planner', 'accountant', 'admin')
  @ApiOperation({ summary: 'Create deal (customerId/articleId or customerName/articleName — resolved or created)' })
  async create(@Body() body: Record<string, unknown>) {
    const customerId = await this.resolveCustomerId(body);
    const articleId = await this.resolveArticleId(body);
    return this.prisma.deal.create({
      data: {
        source: String(body.source || 'Telecom'),
        customerId,
        articleId,
        managerId: body.managerId ? String(body.managerId) : null,
        qtyOrdered: Number(body.qtyOrdered || 0),
        qtyShipped: Number(body.qtyShipped || 0),
        amountOrdered: Number(body.amountOrdered || 0),
        amountPaid: Number(body.amountPaid || 0),
        status: String(body.status || 'прогноз'),
        periodKey: body.periodKey ? String(body.periodKey) : null,
        shipmentDate: body.shipmentDate ? new Date(String(body.shipmentDate)) : null,
        siteCode: body.siteCode ? String(body.siteCode) : null,
        region: body.region ? String(body.region) : null,
        managerName: body.managerName ? String(body.managerName) : null,
        plannedDispatchMonth: body.plannedDispatchMonth ? String(body.plannedDispatchMonth) : null,
        hasFormalRequest: Boolean(body.hasFormalRequest),
      },
      include: { customer: true, article: true, manager: true },
    });
  }

  /**
   * Прогноз спроса до формального заказа: карандашом, правится часто —
   * пересчитывать себестоимость/резервы тут не нужно, это не заказ ещё.
   */
  @Patch(':id')
  @Roles('sales_manager', 'planner', 'accountant', 'admin')
  @ApiOperation({ summary: 'Edit a forecast deal (not yet a formal order)' })
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const existing = await this.prisma.deal.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Deal ${id} not found` });
    }
    const data: Record<string, unknown> = {};
    const strFields = ['source', 'customerId', 'articleId', 'siteCode', 'region', 'managerName', 'plannedDispatchMonth', 'periodKey'];
    for (const f of strFields) if (f in body) data[f] = body[f] ? String(body[f]) : null;
    const numFields = ['qtyOrdered', 'qtyShipped', 'amountOrdered', 'amountPaid'];
    for (const f of numFields) if (f in body) data[f] = Number(body[f] ?? 0);
    if ('hasFormalRequest' in body) data.hasFormalRequest = Boolean(body.hasFormalRequest);
    if ('shipmentDate' in body) data.shipmentDate = body.shipmentDate ? new Date(String(body.shipmentDate)) : null;

    return this.prisma.deal.update({
      where: { id },
      data,
      include: { customer: true, article: true, manager: true },
    });
  }

  @Delete(':id')
  @Roles('sales_manager', 'admin')
  @ApiOperation({ summary: 'Remove a forecast deal that never materialized' })
  async remove(@Param('id') id: string) {
    await this.prisma.deal.delete({ where: { id } });
    return { ok: true };
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
