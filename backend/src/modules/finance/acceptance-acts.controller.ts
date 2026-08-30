import {
  Controller, Get, Post, Param, Query, Body,
  NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';

/**
 * Акты приёмки-передачи (28.08.2026). История пришла из 1С («Реализация
 * товаров и услуг»), а этот контроллер закрывает вторую половину задачи:
 * оформить НОВЫЙ акт на сегодняшнюю отгрузку прямо из карточки заказа —
 * раньше формы не существовало, фиксация выручки шла только через Excel.
 *
 * Акт по умолчанию собирается из позиций заказа: то, что продали, то и
 * передаём. Состав можно порезать — частичная отгрузка обычное дело.
 */
@ApiTags('Acceptance Acts')
@ApiBearerAuth()
@Controller('acceptance-acts')
export class AcceptanceActsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Следующий свободный номер серии сервиса: АПП-001 → АПП-002… */
  private async nextNumber(): Promise<string> {
    const rows = await this.prisma.acceptanceAct.findMany({
      where: { appNumber: { startsWith: 'АПП-' } },
      select: { appNumber: true },
      orderBy: { appNumber: 'desc' },
      take: 200,
    });
    let max = 0;
    for (const r of rows) {
      const n = Number(r.appNumber.slice('АПП-'.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `АПП-${String(max + 1).padStart(3, '0')}`;
  }

  @Get()
  @ApiOperation({ summary: 'Реестр актов приёмки-передачи' })
  async findAll(@Query() query: { orderId?: string; customerId?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const where: any = {};
    if (query.orderId) where.orderId = query.orderId;
    if (query.customerId) where.customerId = query.customerId;

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.acceptanceAct.findMany({
            where,
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: { actDate: 'desc' },
            include: {
              customer: { select: { id: true, name: true, binIin: true } },
              order: { select: { id: true, orderNumber: true } },
              lines: { orderBy: { lineNo: 'asc' } },
            },
          }),
          this.prisma.acceptanceAct.count({ where }),
        ]);
        return {
          data: data.map((a) => ({
            ...a,
            totalAmount: Number(a.totalAmount),
            lines: a.lines.map((l) => ({
              ...l,
              qty: l.qty != null ? Number(l.qty) : null,
              unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
              amount: l.amount != null ? Number(l.amount) : null,
            })),
          })),
          meta: { page, pageSize, total },
        };
      },
      () => ({ data: [], meta: { page, pageSize, total: 0 } }),
    );
  }

  @Post()
  @Roles('accountant', 'sales_manager', 'warehouse_fg', 'admin')
  @ApiOperation({ summary: 'Оформить акт приёмки-передачи по заказу' })
  async create(
    @Body() body: {
      orderId: string;
      actDate?: string;
      appNumber?: string;
      lines: Array<{ orderLineId?: string | null; itemName?: string; qty: number; unitPrice: number }>;
    },
    @CurrentUser() user: UserPayload,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: body.orderId },
      include: {
        customer: { select: { id: true, name: true } },
        orderLines: { include: { article: { select: { id: true, articleCode: true, name: true } } } },
        manager: { select: { id: true, name: true } },
      },
    });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${body.orderId} not found` });

    if (!body.lines?.length) {
      throw new BadRequestException({ code: 'EMPTY_ACT', message: 'В акте нет ни одной позиции' });
    }
    const lineByOrderLine = new Map(order.orderLines.map((l) => [l.id, l]));
    const prepared = body.lines.map((l, idx) => {
      const src = l.orderLineId ? lineByOrderLine.get(l.orderLineId) : null;
      if (l.orderLineId && !src) {
        throw new BadRequestException({
          code: 'LINE_MISMATCH',
          message: `Позиция ${l.orderLineId} не из заказа ${order.orderNumber}`,
        });
      }
      const qty = Number(l.qty);
      const unitPrice = Number(l.unitPrice);
      if (!(qty > 0)) {
        throw new BadRequestException({ code: 'INVALID_QTY', message: `Количество в строке ${idx + 1} должно быть больше нуля` });
      }
      if (!(unitPrice >= 0)) {
        throw new BadRequestException({ code: 'INVALID_PRICE', message: `Цена в строке ${idx + 1} не может быть отрицательной` });
      }
      return {
        lineNo: idx + 1,
        itemName: (l.itemName?.trim() || src?.article?.name || '—'),
        articleId: src?.article?.id ?? null,
        qty,
        unitPrice,
        amount: Math.round(qty * unitPrice * 100) / 100,
        orderNumber: order.orderNumber,
      };
    });
    const totalAmount = Math.round(prepared.reduce((s, l) => s + l.amount, 0) * 100) / 100;

    const appNumber = body.appNumber?.trim() || await this.nextNumber();
    const dup = await this.prisma.acceptanceAct.findUnique({ where: { appNumber } });
    if (dup) {
      throw new ConflictException({ code: 'NUMBER_TAKEN', message: `Акт с номером ${appNumber} уже существует` });
    }
    const actDate = body.actDate ? new Date(body.actDate) : new Date();
    if (Number.isNaN(actDate.getTime())) {
      throw new BadRequestException({ code: 'INVALID_DATE', message: 'Дата акта не распознана' });
    }

    const act = await this.prisma.acceptanceAct.create({
      data: {
        appNumber,
        customerId: order.customerId,
        orderId: order.id,
        actDate,
        totalAmount,
        managerName: order.manager?.name ?? null,
        managerId: order.managerId,
        status: 'Оформлен в сервисе',
        isPosted: true,
        lines: { create: prepared },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } }, customer: { select: { name: true } } },
    });

    // Акт — это ещё и отгрузка: двигаем shippedQty позиций, чтобы state
    // machine видела «отгружено» и заказ мог уйти в SHIPPED без ручного
    // дублирования той же цифры на складе
    for (const l of body.lines) {
      if (!l.orderLineId) continue;
      await this.prisma.orderLine.update({
        where: { id: l.orderLineId },
        data: { shippedQty: { increment: Number(l.qty) } },
      });
    }

    return {
      ...act,
      totalAmount: Number(act.totalAmount),
      lines: act.lines.map((l) => ({
        ...l,
        qty: l.qty != null ? Number(l.qty) : null,
        unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
        amount: l.amount != null ? Number(l.amount) : null,
      })),
    };
  }
}
