import { Controller, Get, Patch, Param, Query, Body, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockMinStockLevels } from '../../common/mock-data';

@ApiTags('Min Stock Levels')
@ApiBearerAuth()
@Controller('min-stock-levels')
export class MinStockController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List min stock levels' })
  async findAll(@Query() query: { articleId?: string; deficitOnly?: string }) {
    const where: any = {};
    if (query.articleId) where.articleId = query.articleId;

    return runWithFallback(
      this.prisma,
      () => this.prisma.minStockLevel.findMany({
        where,
        include: { article: true },
      }),
      () => getMockMinStockLevels(),
    );
  }

  @Patch(':articleId')
  @Roles('planner', 'admin')
  @ApiOperation({ summary: 'Update min stock level' })
  async update(@Param('articleId') articleId: string, @Body() body: any) {
    const existing = await this.prisma.minStockLevel.findFirst({ where: { articleId } });
    if (!existing) throw new NotFoundException({ code: 'NOT_FOUND', message: `MinStockLevel for article ${articleId} not found` });
    return this.prisma.minStockLevel.update({ where: { id: existing.id }, data: body });
  }
}
