import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';

@ApiTags('Analytics Views')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('procurement-needed')
  @Roles('procurement', 'planner', 'director', 'admin')
  @ApiOperation({ summary: 'Read procurement-needed computed view' })
  async getProcurementNeeded(@Query() query: { periodKey?: string }) {
    if (query.periodKey) {
      return this.prisma.$queryRaw`
        SELECT *
        FROM v_procurement_needed
        WHERE period_key = ${query.periodKey}
        ORDER BY purchase_qty DESC, material_code ASC
      `;
    }

    return this.prisma.$queryRaw`
      SELECT *
      FROM v_procurement_needed
      ORDER BY period_key ASC, purchase_qty DESC, material_code ASC
    `;
  }

  @Get('customer-debts')
  @Roles('accountant', 'sales_manager', 'director', 'admin')
  @ApiOperation({ summary: 'Read customer debts computed view' })
  async getCustomerDebts() {
    return this.prisma.$queryRaw`
      SELECT *
      FROM v_customer_debts
      ORDER BY debt_amount DESC, customer_name ASC
    `;
  }

  @Get('supplier-debts')
  @Roles('accountant', 'procurement', 'director', 'admin')
  @ApiOperation({ summary: 'Read supplier debts computed view' })
  async getSupplierDebts() {
    return this.prisma.$queryRaw`
      SELECT *
      FROM v_supplier_debts
      ORDER BY debt_amount DESC, supplier_name ASC
    `;
  }

  @Get('stock-summary')
  @Roles('warehouse_fg', 'planner', 'director', 'admin')
  @ApiOperation({ summary: 'Read stock summary computed view' })
  async getStockSummary() {
    return this.prisma.$queryRaw`
      SELECT *
      FROM v_stock_summary
      ORDER BY article_code ASC
    `;
  }

  @Get('min-stock-readiness')
  @Roles('planner', 'warehouse_fg', 'director', 'admin')
  @ApiOperation({ summary: 'Read minimum stock readiness computed view' })
  async getMinStockReadiness() {
    return this.prisma.$queryRaw`
      SELECT *
      FROM v_min_stock_readiness
      ORDER BY deficit_qty DESC, article_code ASC
    `;
  }
}
