import {
  Controller, Get, Post, Param, Query, Body,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { MaterialBatchService } from '../../services/material-batch.service';
import { BitrixClientService } from '../../services/bitrix-client.service';
import { validatePurchaseRequestMaterialGuard } from '../../services/guards.service';
import { runWithFallback } from '../../common/fallback';
import { getMockPurchaseRequests } from '../../common/mock-data';

/**
 * Заявки на закуп недостающего сырья (26.08.2026).
 *
 * Поток: цех видит на карточке заказа «сырья не хватает» → «В заявку на
 * закуп» кладёт дефицит в очередь (DRAFT, дедуп по материалу). Снабженец
 * на вкладке «На закуп» выбирает накопленное и отправляет ОДНОЙ сделкой
 * в воронку снабжения Б24 — «не из-за одного болта» (решение пользователя).
 * Когда по воронке в 1С создан заказ поставщику, заявка становится ORDERED.
 */
@ApiTags('Purchase Requests')
@ApiBearerAuth()
@Controller('purchase-requests')
export class PurchaseRequestsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly batches: MaterialBatchService,
    private readonly bitrix: BitrixClientService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Список заявок на закуп' })
  async findAll(@Query() query: { status?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 100;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.status) where.status = query.status;

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.purchaseRequest.findMany({
            where, skip, take: pageSize,
            orderBy: { createdAt: 'desc' },
            include: {
              material: { select: { materialCode: true, name: true, unit: true, purchasePrice: true } },
              order: { select: { id: true, orderNumber: true } },
            },
          }),
          this.prisma.purchaseRequest.count({ where }),
        ]);
        return { data, meta: { page, pageSize, total } };
      },
      () => getMockPurchaseRequests(page, pageSize),
    );
  }

  @Post()
  @Roles('warehouse_material', 'planner', 'shop_foreman', 'procurement', 'admin')
  @ApiOperation({ summary: 'Создать заявку вручную' })
  async create(
    @Body() body: { materialId: string; requestedQty: number; note?: string; orderId?: string },
    @CurrentUser() user: UserPayload,
  ) {
    if (!body.materialId || !(Number(body.requestedQty) > 0)) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Нужны materialId и requestedQty > 0' });
    }
    const material = await this.prisma.material.findUnique({ where: { id: body.materialId } });
    if (!material) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Material ${body.materialId} not found` });
    }
    // Гард написан и покрыт тестами с самого начала — но не был подключён
    // ни к одному контроллеру: create принимал body как есть
    validatePurchaseRequestMaterialGuard((material as any).isActive ?? true, material.materialCode);
    return this.prisma.purchaseRequest.create({
      data: {
        materialId: body.materialId,
        requestedQty: body.requestedQty,
        unit: material!.unit,
        estimatedPrice: material!.lastPurchasePrice ?? material!.purchasePrice,
        note: body.note ?? null,
        orderId: body.orderId ?? null,
        requestedById: user.userId.startsWith('usr-') ? null : user.userId,
      },
      include: { material: true },
    });
  }

  /**
   * Дефицит заказа → очередь заявок. Дедуп: один DRAFT на материал,
   * количество суммируется — пять заказов с нехваткой одного болта
   * дают одну строку с общим объёмом, а не пять заявок.
   */
  @Post('from-order/:orderId')
  @Roles('warehouse_material', 'planner', 'shop_foreman', 'procurement', 'admin')
  @ApiOperation({ summary: 'Положить дефицит заказа в очередь на закуп' })
  async fromOrder(@Param('orderId') orderId: string, @CurrentUser() user: UserPayload) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${orderId} not found` });

    const availability = await this.batches.orderMaterialAvailability(orderId);
    if (availability.shortages.length === 0) {
      return { created: 0, updated: 0, message: 'Дефицита нет — сырья хватает' };
    }

    let created = 0;
    let updated = 0;
    for (const s of availability.shortages) {
      const existing = await this.prisma.purchaseRequest.findFirst({
        where: { materialId: s.materialId, status: 'DRAFT' },
      });
      if (existing) {
        await this.prisma.purchaseRequest.update({
          where: { id: existing.id },
          data: {
            requestedQty: { increment: s.shortage },
            note: [existing.note, `+ ${order.orderNumber}`].filter(Boolean).join(' '),
          },
        });
        updated += 1;
      } else {
        await this.prisma.purchaseRequest.create({
          data: {
            materialId: s.materialId,
            requestedQty: s.shortage,
            unit: s.unit,
            estimatedPrice: s.estimatedPrice || null,
            orderId,
            note: `Дефицит по заказу ${order.orderNumber}`,
            requestedById: user.userId.startsWith('usr-') ? null : user.userId,
          },
        });
        created += 1;
      }
    }
    return { created, updated, shortages: availability.shortages.length };
  }

  /**
   * Пачка накопленного → ОДНА сделка в воронке снабжения Б24.
   * Отсутствие вебхука — честная ошибка снабженцу, не тихий no-op:
   * человек нажал кнопку и должен знать, ушла заявка или нет.
   */
  @Post('send-to-bitrix')
  @Roles('procurement', 'admin')
  @ApiOperation({ summary: 'Отправить выбранные заявки одной сделкой в Б24 (воронка снабжения)' })
  async sendToBitrix(@Body() body: { ids: string[] }, @CurrentUser() user: UserPayload) {
    if (!body.ids?.length) {
      throw new BadRequestException({ code: 'EMPTY_SELECTION', message: 'Не выбрано ни одной заявки' });
    }
    const requests = await this.prisma.purchaseRequest.findMany({
      where: { id: { in: body.ids }, status: 'DRAFT' },
      include: { material: { select: { materialCode: true, name: true, unit: true } } },
    });
    if (requests.length === 0) {
      throw new BadRequestException({ code: 'NOTHING_TO_SEND', message: 'Среди выбранных нет заявок в статусе «накоплено»' });
    }

    const lines = requests.map((r) => ({
      code: r.material.materialCode,
      name: r.material.name,
      qty: Number(r.requestedQty),
      unit: r.unit ?? r.material.unit,
      estPrice: Number(r.estimatedPrice ?? 0),
    }));
    const totalEstimate = lines.reduce((s, l) => s + l.qty * l.estPrice, 0);

    let dealId: string;
    try {
      dealId = await this.bitrix.createSupplyDeal({
        title: `Заявка на закуп: ${lines.length} позиций на ${Math.round(totalEstimate).toLocaleString('ru-RU')} ₸`,
        lines,
        totalEstimate,
        requestedBy: user.email ?? user.roles[0],
      });
    } catch (e) {
      throw new BadRequestException({
        code: 'BITRIX_SEND_FAILED',
        message: e instanceof Error ? e.message : 'Не удалось отправить в Б24',
      });
    }

    await this.prisma.purchaseRequest.updateMany({
      where: { id: { in: requests.map((r) => r.id) } },
      data: { status: 'APPROVED', bitrixDealId: dealId, bitrixSentAt: new Date() },
    });
    return { sent: requests.length, dealId, totalEstimate: Math.round(totalEstimate) };
  }

  @Post(':id/reject')
  @Roles('procurement', 'admin')
  @ApiOperation({ summary: 'Отклонить заявку (например, дефицит ложный)' })
  async reject(@Param('id') id: string) {
    const req = await this.prisma.purchaseRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Purchase request ${id} not found` });
    return this.prisma.purchaseRequest.update({ where: { id }, data: { status: 'REJECTED' } });
  }

  @Post(':id/ordered')
  @Roles('procurement', 'admin')
  @ApiOperation({ summary: 'Отметить: по заявке создан заказ поставщику в 1С' })
  async markOrdered(@Param('id') id: string) {
    const req = await this.prisma.purchaseRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Purchase request ${id} not found` });
    return this.prisma.purchaseRequest.update({ where: { id }, data: { status: 'ORDERED' } });
  }
}
