import { Controller, Get, Post, Patch, Param, Query, Body, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockPurchaseRequests } from '../../common/mock-data';

@ApiTags('Purchase Requests')
@ApiBearerAuth()
@Controller('purchase-requests')
export class PurchaseRequestsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List purchase requests' })
  async findAll(@Query() query: { status?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.status) where.status = query.status;

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.purchaseRequest.findMany({ where, skip, take: pageSize, orderBy: { createdAt: 'desc' }, include: { material: true } }),
          this.prisma.purchaseRequest.count({ where }),
        ]);

        return { data, meta: { page, pageSize, total } };
      },
      () => getMockPurchaseRequests(page, pageSize),
    );
  }

  @Post()
  @Roles('warehouse_material', 'planner', 'admin')
  @ApiOperation({ summary: 'Create purchase request' })
  async create(@Body() body: any) {
    return this.prisma.purchaseRequest.create({ data: body, include: { material: true } });
  }

  @Post(':id/approve')
  @Roles('procurement', 'admin')
  @ApiOperation({ summary: 'Approve purchase request' })
  async approve(@Param('id') id: string) {
    const req = await this.prisma.purchaseRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Purchase request ${id} not found` });
    return this.prisma.purchaseRequest.update({ where: { id }, data: { status: 'APPROVED' } });
  }
}
