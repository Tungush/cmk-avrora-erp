import {
  Controller, Get, Post, Param, Query, Body,
  NotFoundException, ConflictException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Отклонение прайса от расчёта, как в explainCosting: (прайс − расчёт) / расчёт */
export function priceDeviationPct(approvedPrice: number, calculatedPrice: number): number {
  if (calculatedPrice <= 0) return 0;
  return round2(((approvedPrice - calculatedPrice) / calculatedPrice) * 100);
}

/**
 * Пересмотр утверждённой цены (§3.4 07_ARCHITECTURE_AND_UX.md).
 * Каскад пересчёта НЕ трогает approvedPrice — цена меняется только здесь,
 * решением директора (article.price:approve), с историей и аудитом.
 */
@ApiTags('Catalog - Price reviews')
@ApiBearerAuth()
@Controller()
export class PriceReviewsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('articles/:articleId/price-review')
  @Roles('engineer', 'accountant', 'sales_manager', 'admin')
  @ApiOperation({ summary: 'Запросить пересмотр цены (расчёт разошёлся с прайсом)' })
  async request(
    @Param('articleId') articleId: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${articleId} not found` });

    const pending = await this.prisma.priceReviewRequest.findFirst({
      where: { articleId, status: 'PENDING' },
    });
    if (pending) {
      throw new ConflictException({
        code: 'REVIEW_ALREADY_PENDING',
        message: `Заявка на пересмотр цены ${article.articleCode} уже на рассмотрении`,
      });
    }

    const calculated = Number(article.specPrice);
    const approved = Number(article.approvedPrice);

    return this.prisma.priceReviewRequest.create({
      data: {
        articleId,
        calculatedPrice: calculated,
        approvedPrice: approved,
        deviationPct: priceDeviationPct(approved, calculated),
        reason: body.reason ?? null,
        requestedById: user.userId.startsWith('usr-') ? null : user.userId,
      },
      include: { article: { select: { articleCode: true, name: true } } },
    });
  }

  @Get('price-reviews')
  @Roles('director', 'admin', 'engineer', 'accountant')
  @ApiOperation({ summary: 'Заявки на пересмотр цен' })
  async list(@Query() query: { status?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 25;
    const where: any = {};
    if (query.status) where.status = query.status;

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.priceReviewRequest.findMany({
            where,
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: { createdAt: 'desc' },
            include: { article: { select: { articleCode: true, name: true, specPrice: true, approvedPrice: true } } },
          }),
          this.prisma.priceReviewRequest.count({ where }),
        ]);
        return { data, meta: { page, pageSize, total } };
      },
      () => ({ data: [], meta: { page, pageSize, total: 0 } }),
    );
  }

  /** Общая часть approve/reject: найти PENDING-заявку */
  private async findPending(id: string) {
    const review = await this.prisma.priceReviewRequest.findUnique({
      where: { id },
      include: { article: true },
    });
    if (!review) throw new NotFoundException({ code: 'NOT_FOUND', message: `Review ${id} not found` });
    if (review.status !== 'PENDING') {
      throw new ConflictException({ code: 'REVIEW_ALREADY_DECIDED', message: 'Заявка уже рассмотрена' });
    }
    return review;
  }

  @Post('price-reviews/:id/approve')
  @Roles('director', 'admin')
  @ApiOperation({ summary: 'Утвердить новую цену (article.price:approve, §1.7)' })
  async approve(
    @Param('id') id: string,
    @Body() body: { newPrice: number; comment?: string },
    @CurrentUser() user: UserPayload,
  ) {
    if (!(Number(body.newPrice) > 0)) {
      throw new BadRequestException({ code: 'INVALID_PRICE', message: 'newPrice должен быть > 0' });
    }
    const review = await this.findPending(id);
    const isDbUser = !user.userId.startsWith('usr-');

    const [updated] = await this.prisma.$transaction([
      this.prisma.priceReviewRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          newPrice: body.newPrice,
          decisionComment: body.comment ?? null,
          decidedById: isDbUser ? user.userId : null,
          decidedAt: new Date(),
        },
        include: { article: { select: { articleCode: true, name: true } } },
      }),
      this.prisma.article.update({
        where: { id: review.articleId },
        data: { approvedPrice: body.newPrice },
      }),
      // Аудит обязателен (§1.7: не молчаливый PATCH)
      this.prisma.auditLogEntry.create({
        data: {
          entityType: 'Article',
          entityId: review.articleId,
          action: 'price_approved',
          before: { approvedPrice: Number(review.article.approvedPrice) } as any,
          after: { approvedPrice: Number(body.newPrice) } as any,
          userId: isDbUser ? user.userId : null,
          userRole: user.roles[0],
          comment: body.comment ?? null,
        },
      }),
      // История цен — только для пользователей из БД (FK на users)
      ...(isDbUser
        ? [this.prisma.priceHistory.create({
            data: {
              articleId: review.articleId,
              price: body.newPrice,
              validFrom: new Date(),
              changedBy: user.userId,
            },
          })]
        : []),
    ]);

    return updated;
  }

  @Post('price-reviews/:id/reject')
  @Roles('director', 'admin')
  @ApiOperation({ summary: 'Отклонить заявку — прайс остаётся прежним' })
  async reject(
    @Param('id') id: string,
    @Body() body: { comment?: string },
    @CurrentUser() user: UserPayload,
  ) {
    await this.findPending(id);
    const isDbUser = !user.userId.startsWith('usr-');

    return this.prisma.priceReviewRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        decisionComment: body.comment ?? null,
        decidedById: isDbUser ? user.userId : null,
        decidedAt: new Date(),
      },
      include: { article: { select: { articleCode: true, name: true } } },
    });
  }
}
