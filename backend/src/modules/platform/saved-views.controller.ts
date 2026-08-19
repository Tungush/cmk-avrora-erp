import {
  Controller, Get, Post, Delete, Param, Query, Body,
  NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';

/**
 * Сохраняемые представления (§2.1): замена «Данные → Фильтр» из Google Sheets.
 * Вид = имя + фильтры + пресет колонок; приватен для владельца (по email).
 */
@ApiTags('Platform - Saved views')
@ApiBearerAuth()
@Controller('saved-views')
export class SavedViewsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Мои представления модуля' })
  async list(@Query('module') module: string, @CurrentUser() user: UserPayload) {
    return runWithFallback(
      this.prisma,
      () => this.prisma.savedView.findMany({
        where: { module: module || 'orders', ownerEmail: user.email },
        orderBy: { createdAt: 'asc' },
      }),
      () => [],
    );
  }

  @Post()
  @ApiOperation({ summary: 'Сохранить текущий вид' })
  async create(
    @Body() body: { module: string; name: string; config: Record<string, unknown> },
    @CurrentUser() user: UserPayload,
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException({ code: 'INVALID_NAME', message: 'Имя представления обязательно' });
    }
    return this.prisma.savedView.create({
      data: {
        module: body.module || 'orders',
        name: body.name.trim().slice(0, 100),
        ownerEmail: user.email,
        config: (body.config ?? {}) as any,
      },
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Удалить своё представление' })
  async remove(@Param('id') id: string, @CurrentUser() user: UserPayload) {
    const view = await this.prisma.savedView.findUnique({ where: { id } });
    if (!view) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Представление не найдено' });
    if (view.ownerEmail !== user.email) {
      throw new ForbiddenException({ code: 'NOT_OWNER', message: 'Чужое представление удалить нельзя' });
    }
    await this.prisma.savedView.delete({ where: { id } });
    return { deleted: true };
  }
}
