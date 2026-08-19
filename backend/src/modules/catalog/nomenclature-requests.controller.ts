import {
  Controller, Get, Post, Param, Query, Body,
  NotFoundException, ConflictException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { IntegrationService } from '../../services/integration.service';

/** Серии артикулов из исходной таблицы: k — крепёж, n/d/t — изделия, z — заказные */
const KNOWN_SERIES = ['k', 'n', 'd', 't', 'z', 'a', 'b'];

/**
 * Заявки на создание номенклатуры — процесс «как в 1С»:
 * нет артикула → заявка → при одобрении номенклатуре присваивается артикул
 * (следующий свободный в серии) и создаётся карточка изделия.
 * Когда появится интеграция (Этап 5 роадмапа), вебхук 1С сможет закрывать
 * эти же заявки готовым кодом.
 */
@ApiTags('Catalog - Nomenclature requests')
@ApiBearerAuth()
@Controller('nomenclature-requests')
export class NomenclatureRequestsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integration: IntegrationService,
  ) {}

  /** Следующий свободный артикул в серии: k-001 → k-002 … */
  private async nextArticleCode(series: string): Promise<string> {
    const prefix = `${series}-`;
    const existing = await this.prisma.article.findMany({
      where: { articleCode: { startsWith: prefix } },
      select: { articleCode: true },
    });
    let max = 0;
    for (const a of existing) {
      const n = Number(a.articleCode.slice(prefix.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  @Post()
  @Roles('engineer', 'sales_manager', 'planner', 'admin')
  @ApiOperation({ summary: 'Запросить создание номенклатуры (нет артикула)' })
  async create(
    @Body() body: { proposedName: string; series?: string; description?: string; reason?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const name = body.proposedName?.trim();
    if (!name) {
      throw new BadRequestException({ code: 'INVALID_NAME', message: 'Укажите наименование изделия' });
    }

    // Возможно, изделие уже есть — подсказываем вместо дубля заявки
    const existing = await this.prisma.article.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, articleCode: true, name: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'ARTICLE_EXISTS',
        message: `Такое изделие уже есть: ${existing.articleCode} — ${existing.name}`,
      });
    }
    const pending = await this.prisma.nomenclatureRequest.findFirst({
      where: { proposedName: { equals: name, mode: 'insensitive' }, status: 'PENDING' },
    });
    if (pending) {
      throw new ConflictException({
        code: 'REQUEST_ALREADY_PENDING',
        message: 'Заявка на эту номенклатуру уже на рассмотрении',
      });
    }

    // Заявка и сообщение для 1С пишутся одной транзакцией (§3.3):
    // иначе заявка есть, а в 1С не ушла, и никто не заметил
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.nomenclatureRequest.create({
        data: {
          proposedName: name,
          series: body.series && KNOWN_SERIES.includes(body.series) ? body.series : null,
          description: body.description?.trim() || null,
          reason: body.reason?.trim() || null,
          requestedBy: user.email,
        },
      });
      await this.integration.enqueue(tx, {
        type: 'nomenclature.requested',
        entityType: 'NomenclatureRequest',
        entityId: request.id,
        payload: {
          requestId: request.id,
          name: request.proposedName,
          series: request.series,
          description: request.description,
          reason: request.reason,
          requestedBy: request.requestedBy,
        },
      });
      return request;
    });
  }

  @Get()
  @Roles('engineer', 'sales_manager', 'planner', 'director', 'admin')
  @ApiOperation({ summary: 'Заявки на номенклатуру' })
  async list(@Query() query: { status?: string }) {
    return runWithFallback(
      this.prisma,
      () => this.prisma.nomenclatureRequest.findMany({
        where: query.status ? { status: query.status as any } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { article: { select: { articleCode: true, name: true } } },
      }),
      () => [],
    );
  }

  @Post(':id/approve')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Создать номенклатуру: присвоить артикул (следующий в серии)' })
  async approve(
    @Param('id') id: string,
    @Body() body: { articleCode?: string; series?: string; comment?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const request = await this.prisma.nomenclatureRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
    if (request.status !== 'PENDING') {
      throw new ConflictException({ code: 'ALREADY_DECIDED', message: 'Заявка уже рассмотрена' });
    }

    // Код из 1С (если пришёл) — иначе следующий свободный в серии
    let articleCode = body.articleCode?.trim();
    if (articleCode) {
      const dup = await this.prisma.article.findUnique({ where: { articleCode } });
      if (dup) throw new ConflictException({ code: 'DUPLICATE_CODE', message: `Артикул ${articleCode} уже занят` });
    } else {
      const series = body.series ?? request.series ?? 'n';
      articleCode = await this.nextArticleCode(series);
    }

    const [article, updated] = await this.prisma.$transaction(async (tx) => {
      const created = await tx.article.create({
        data: {
          articleCode: articleCode!,
          name: request.proposedName,
          series: request.series,
          description: request.description,
          isActive: true,
        },
      });
      const req = await tx.nomenclatureRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          articleId: created.id,
          decidedBy: user.email,
          decidedAt: new Date(),
          decisionComment: body.comment ?? null,
        },
        include: { article: { select: { articleCode: true, name: true } } },
      });
      await tx.auditLogEntry.create({
        data: {
          entityType: 'Article',
          entityId: created.id,
          action: 'nomenclature_created',
          after: { articleCode: created.articleCode, name: created.name } as any,
          userId: user.userId.startsWith('usr-') ? null : user.userId,
          userRole: user.roles[0],
          comment: `Заявка на номенклатуру от ${request.requestedBy ?? '—'}`,
        },
      });
      return [created, req];
    });

    return { request: updated, article };
  }

  @Post(':id/reject')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Отклонить заявку на номенклатуру' })
  async reject(
    @Param('id') id: string,
    @Body() body: { comment?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const request = await this.prisma.nomenclatureRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
    if (request.status !== 'PENDING') {
      throw new ConflictException({ code: 'ALREADY_DECIDED', message: 'Заявка уже рассмотрена' });
    }
    return this.prisma.nomenclatureRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        decidedBy: user.email,
        decidedAt: new Date(),
        decisionComment: body.comment ?? null,
      },
    });
  }
}
