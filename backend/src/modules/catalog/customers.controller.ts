import { Controller, Get, Post, Patch, Param, Query, Body, NotFoundException, ConflictException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockCustomers } from '../../common/mock-data';

@ApiTags('Catalog - Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List customers' })
  async findAll(@Query() query: { search?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { binIin: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.customer.findMany({ where, skip, take: pageSize, orderBy: { name: 'asc' } }),
          this.prisma.customer.count({ where }),
        ]);

        return { data, meta: { page, pageSize, total } };
      },
      () => getMockCustomers(page, pageSize),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get customer by ID' })
  async findOne(@Param('id') id: string) {
    const c = await this.prisma.customer.findUnique({ where: { id } });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: `Customer ${id} not found` });
    return c;
  }

  @Post()
  @Roles('sales_manager', 'admin')
  @ApiOperation({ summary: 'Create customer' })
  async create(@Body() body: any) {
    const existing = await this.prisma.customer.findUnique({ where: { binIin: body.binIin } });
    if (existing) throw new ConflictException({ code: 'DUPLICATE_ENTITY', message: `Customer BIN ${body.binIin} already exists` });
    return this.prisma.customer.create({ data: body });
  }

  @Patch(':id')
  @Roles('sales_manager', 'admin')
  @ApiOperation({ summary: 'Update customer' })
  async update(@Param('id') id: string, @Body() body: any) {
    const c = await this.prisma.customer.findUnique({ where: { id } });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: `Customer ${id} not found` });
    return this.prisma.customer.update({ where: { id }, data: body });
  }
}
