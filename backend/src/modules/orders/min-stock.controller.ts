import { Controller, Get, Patch, Delete, Param, Query, Body, NotFoundException, BadRequestException } from '@nestjs/common';
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

  /**
   * Факт считается ЖИВЫМ из движений ГП, а не из хранимого actualQty
   * (28.08.2026): хранимое число никто не обновлял, и норматив сверялся
   * бы с нулём. Дефицит и готовность — производные от живого остатка.
   */
  @Get()
  @ApiOperation({ summary: 'Минимальные остатки: норматив против живого остатка ГП' })
  async findAll(@Query() query: { articleId?: string; deficitOnly?: string }) {
    const where: any = {};
    if (query.articleId) where.articleId = query.articleId;

    return runWithFallback(
      this.prisma,
      async () => {
        const levels = await this.prisma.minStockLevel.findMany({
          where,
          include: { article: { select: { id: true, articleCode: true, name: true, approvedPrice: true } } },
        });
        if (levels.length === 0) return [];

        const grouped = await this.prisma.finishedGoodsMovement.groupBy({
          by: ['itemId', 'movementType'],
          where: { itemId: { in: levels.map((l) => l.articleId) } },
          _sum: { qty: true },
        });
        const PLUS = new Set(['RECEIPT', 'FROM_PRODUCTION', 'RETURN']);
        const stockByArticle = new Map<string, number>();
        for (const g of grouped) {
          const q = Number(g._sum.qty ?? 0);
          const signed = PLUS.has(g.movementType) ? q : g.movementType === 'CORRECTION' ? q : -q;
          stockByArticle.set(g.itemId, (stockByArticle.get(g.itemId) ?? 0) + signed);
        }

        const rows = levels.map((l) => {
          const target = Number(l.targetQty);
          const actual = Math.round((stockByArticle.get(l.articleId) ?? 0) * 1000) / 1000;
          const deficit = Math.max(0, Math.round((target - actual) * 1000) / 1000);
          return {
            id: l.id,
            articleId: l.articleId,
            article: l.article,
            periodMonths: Number(l.periodMonths),
            targetQty: target,
            actualQty: actual,
            deficitQty: deficit,
            readinessPct: target > 0 ? Math.min(100, Math.round((actual / target) * 1000) / 10) : 100,
            deficitValue: Math.round(deficit * Number(l.article.approvedPrice) * 100) / 100,
          };
        });
        const filtered = query.deficitOnly === 'true' ? rows.filter((r) => r.deficitQty > 0) : rows;
        return filtered.sort((a, b) => b.deficitValue - a.deficitValue);
      },
      () => getMockMinStockLevels(),
    );
  }

  /**
   * Upsert, а не update: норматив на изделие заводится впервые именно
   * отсюда — 404 на первом же вводе делал экран бесполезным.
   */
  @Patch(':articleId')
  @Roles('planner', 'admin')
  @ApiOperation({ summary: 'Задать норматив минимального остатка' })
  async update(
    @Param('articleId') articleId: string,
    @Body() body: { targetQty?: number; periodMonths?: number },
  ) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId }, select: { id: true } });
    if (!article) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${articleId} not found` });

    const data: any = {};
    if (body.targetQty !== undefined) {
      if (!(Number(body.targetQty) >= 0)) {
        throw new BadRequestException({ code: 'INVALID_QTY', message: 'Норматив не может быть отрицательным' });
      }
      data.targetQty = Number(body.targetQty);
    }
    if (body.periodMonths !== undefined && Number(body.periodMonths) > 0) {
      data.periodMonths = Number(body.periodMonths);
    }

    const existing = await this.prisma.minStockLevel.findFirst({ where: { articleId } });
    if (existing) {
      return this.prisma.minStockLevel.update({ where: { id: existing.id }, data });
    }
    return this.prisma.minStockLevel.create({ data: { articleId, ...data } });
  }

  @Delete(':articleId')
  @Roles('planner', 'admin')
  @ApiOperation({ summary: 'Снять норматив с изделия' })
  async remove(@Param('articleId') articleId: string) {
    const existing = await this.prisma.minStockLevel.findFirst({ where: { articleId } });
    if (!existing) throw new NotFoundException({ code: 'NOT_FOUND', message: `Норматив для ${articleId} не найден` });
    await this.prisma.minStockLevel.delete({ where: { id: existing.id } });
    return { deleted: true };
  }
}
