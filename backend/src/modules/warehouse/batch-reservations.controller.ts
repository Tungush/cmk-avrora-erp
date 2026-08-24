import { Controller, Get, Post, Param, Query, Body, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { BatchReservationService } from '../../services/batch-reservation.service';

/**
 * Резервы партий и перехват (09 §4.4). Предупреждение — всем, решение —
 * директору.
 */
@ApiTags('Batch Reservations')
@ApiBearerAuth()
@Controller('batch-reservations')
export class BatchReservationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: BatchReservationService,
  ) {}

  @Get('availability/:materialId')
  @ApiOperation({ summary: 'Партии материала со свободным остатком и блокировщиками' })
  async availability(
    @Param('materialId') materialId: string,
    @Query('orderId') orderId?: string,
  ) {
    const data = await this.reservations.availability(materialId, orderId ?? null);
    return { data, total: data.length };
  }

  @Post('assess')
  @ApiOperation({ summary: 'Хватит ли партии и нужно ли согласование' })
  async assess(@Body() body: { batchId: string; orderId: string; qty: number }) {
    if (!body?.batchId || !body?.orderId) {
      throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Нужны batchId и orderId' });
    }
    return this.reservations.assess(body.batchId, body.orderId, Number(body.qty) || 0);
  }

  @Post('from-costing/:costingId')
  @Roles('procurement', 'planner', 'admin')
  @ApiOperation({ summary: 'Зарезервировать партии под согласованную калькуляцию' })
  async reserve(@Param('costingId') costingId: string, @CurrentUser() user: UserPayload) {
    return this.reservations.reserveForCosting(costingId, user?.userId);
  }

  @Post('overrides')
  @Roles('sales_manager', 'planner', 'procurement', 'admin')
  @ApiOperation({ summary: 'Запросить перехват чужого резерва' })
  async requestOverride(
    @Body() body: { reservationId: string; requestedByOrderId: string; qtyRequested: number; reason: string },
    @CurrentUser() user: UserPayload,
  ) {
    return this.reservations.requestOverride({
      ...body,
      qtyRequested: Number(body.qtyRequested) || 0,
    }, user?.userId);
  }

  @Get('overrides')
  @ApiOperation({ summary: 'Очередь запросов на перехват' })
  async listOverrides(@Query('status') status?: string) {
    const now = Date.now();
    const rows = await this.prisma.batchOverrideRequest.findMany({
      where: status ? { status: status as any } : { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        reservation: {
          select: {
            orderId: true,
            qty: true,
            batch: {
              select: {
                unitPrice: true,
                material: { select: { materialCode: true, name: true, unit: true } },
              },
            },
          },
        },
      },
    });

    // Номера заказов, а не UUID: директор решает про «DEMO-1007 просит
    // у DEMO-1006», а не про пару шестнадцатеричных строк
    const orderIds = [...new Set(rows.flatMap((r) => [r.requestedByOrderId, r.reservation.orderId]))];
    const orders = orderIds.length
      ? await this.prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderNumber: true, plannedShipmentDate: true },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));

    return {
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        qtyRequested: Number(r.qtyRequested),
        reason: r.reason,
        createdAt: r.createdAt,
        requestedByOrderId: r.requestedByOrderId,
        requestedByOrder: orderById.get(r.requestedByOrderId) ?? null,
        holderOrderId: r.reservation.orderId,
        holderOrder: orderById.get(r.reservation.orderId) ?? null,
        material: r.reservation.batch.material,
        unitPrice: Number(r.reservation.batch.unitPrice),
        reservedQty: Number(r.reservation.qty),
        // Возраст на виду: если очередь к директору начнёт копиться,
        // это будет заметно за неделю, а не через квартал
        ageHours: Math.floor((now - new Date(r.createdAt).getTime()) / 3_600_000),
      })),
      total: rows.length,
    };
  }

  /**
   * Резервы, истекающие в ближайшие дни, — сюда ведёт ссылка с экрана
   * директора. Резерв протухает через 30 дней без движения (09 §4.4):
   * список показывает, чей металл вот-вот освободится.
   */
  @Get('expiring')
  @ApiOperation({ summary: 'Резервы, истекающие в ближайшие дни' })
  async listExpiring(@Query('days') days?: string) {
    const horizon = Math.max(1, Number(days) || 3);
    const rows = await this.prisma.batchReservation.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lt: new Date(Date.now() + horizon * 86_400_000) },
      },
      orderBy: { expiresAt: 'asc' },
      include: {
        order: { select: { id: true, orderNumber: true, status: true } },
        batch: {
          select: {
            unitPrice: true,
            material: { select: { materialCode: true, name: true, unit: true } },
          },
        },
      },
      take: 100,
    });
    const now = Date.now();
    return {
      data: rows.map((r) => ({
        id: r.id,
        order: r.order,
        material: r.batch.material,
        qty: Number(r.qty),
        unitPrice: Number(r.batch.unitPrice),
        expiresAt: r.expiresAt,
        daysLeft: Math.max(0, Math.ceil((new Date(r.expiresAt).getTime() - now) / 86_400_000)),
      })),
      total: rows.length,
    };
  }

  @Get('overrides/:requestId')
  @ApiOperation({ summary: 'Обе стороны на одном экране: чей резерв, во что обойдётся' })
  async overrideContext(@Param('requestId') requestId: string) {
    return this.reservations.overrideContext(requestId);
  }

  @Post('overrides/:requestId/decide')
  @Roles('director', 'admin')
  @ApiOperation({ summary: 'Решение директора по перехвату' })
  async decide(
    @Param('requestId') requestId: string,
    @Body() body: { approve: boolean; comment?: string },
    @CurrentUser() user: UserPayload,
  ) {
    return this.reservations.decideOverride(requestId, body, {
      userId: user?.userId,
      roles: user?.roles,
    });
  }

  @Post('expire-stale')
  @Roles('admin')
  @ApiOperation({ summary: 'Снять протухшие резервы и предупредить об истекающих' })
  async expireStale() {
    return this.reservations.expireStale();
  }
}
