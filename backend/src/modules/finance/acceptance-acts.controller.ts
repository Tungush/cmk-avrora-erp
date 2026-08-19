import { Controller, Post, Body, ConflictException, NotFoundException, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockAcceptanceActs } from '../../common/mock-data';

@ApiTags('Finance - Acceptance Acts')
@ApiBearerAuth()
@Controller('acceptance-acts')
export class AcceptanceActsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List acceptance acts' })
  async findAll(@Query() query: { customerId?: string; orderId?: string }) {
    const where: any = {};
    if (query.customerId) where.customerId = query.customerId;
    if (query.orderId) where.orderId = query.orderId;

    return runWithFallback(
      this.prisma,
      () => this.prisma.acceptanceAct.findMany({
        where,
        include: { customer: true, order: true },
        orderBy: { actDate: 'desc' },
      }),
      () => getMockAcceptanceActs(),
    );
  }

  @Post()
  @Roles('sales_manager', 'accountant', 'admin')
  @ApiOperation({ summary: 'Create acceptance act (APP)' })
  async create(@Body() body: any) {
    const appNumber = body.appNumber || body.actNumber;
    const existing = await this.prisma.acceptanceAct.findUnique({ where: { appNumber } });
    if (existing) throw new ConflictException({ code: 'DUPLICATE_ENTITY', message: `Act number ${appNumber} already exists` });

    return this.prisma.acceptanceAct.create({
      data: {
        appNumber,
        orderId: body.orderId,
        customerId: body.customerId,
        totalAmount: body.totalAmount || body.amount || 0,
        actDate: new Date(body.actDate || Date.now()),
      },
    });
  }
}
