import { Controller, Get, Post, Param, Query, Body, NotFoundException, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockMaterialBalance } from '../../common/mock-data';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { MaterialReceiptService } from '../../services/material-receipt.service';
import { MaterialBatchService } from '../../services/material-batch.service';

@ApiTags('Warehouse')
@ApiBearerAuth()
@Controller('warehouse')
export class WarehouseController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receipts: MaterialReceiptService,
    private readonly batches: MaterialBatchService,
  ) {}

  @Get('materials/balance')
  @ApiOperation({ summary: 'Get material stock balances' })
  async getMaterialBalance(@Query() query: { search?: string; category?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 100;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.category) where.category = query.category;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { materialCode: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return runWithFallback(
      this.prisma,
      async () => {
        const materials = await this.prisma.material.findMany({
          where, skip, take: pageSize, orderBy: { name: 'asc' },
        });

        return materials.map(m => ({
          materialId: m.id,
          materialCode: m.materialCode,
          name: m.name,
          category: m.category,
          unit: m.unit,
          stockQty: Number(m.stockQty),
          purchasePrice: Number(m.purchasePrice),
          totalValue: Number(m.stockQty) * Number(m.purchasePrice),
        }));
      },
      () => getMockMaterialBalance(),
    );
  }

  /**
   * Приход материала: «занесли то, что купили».
   * Учётная цена — средневзвешенная по остатку (стандарт для себестоимости:
   * одна дорогая партия не должна мгновенно задирать все калькуляции).
   * Изменилась цена → каскад: lineCost всех составов с этим материалом
   * и точечный пересчёт себестоимости затронутых изделий.
   */
  @Post('materials/receipt')
  @Roles('warehouse_material', 'procurement', 'admin')
  @ApiOperation({ summary: 'Приход материала (закуп): остаток + цена + каскад в себестоимость' })
  async postMaterialReceipt(
    @Body() body: {
      materialId: string; qty: number; unitPrice: number;
      movementDate?: string; supplierName?: string; documentNumber?: string; comment?: string;
    },
    @CurrentUser() user: UserPayload,
  ) {
    return this.receipts.receive(body, user?.userId);
  }

  @Get('materials/:id/movements')
  @ApiOperation({ summary: 'История движений материала — за сколько и когда покупали' })
  async getMaterialMovements(@Param('id') id: string, @Query('limit') limit?: string) {
    return runWithFallback(
      this.prisma,
      () => this.prisma.materialStockMovement.findMany({
        where: { itemId: id },
        orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
        take: Number(limit) || 50,
      }),
      () => [],
    );
  }

  @Get('receipts')
  @ApiOperation({ summary: 'Журнал приходов материалов' })
  async getReceipts(@Query() query: { search?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const where: any = { movementType: 'RECEIPT' };
    if (query.search) {
      where.OR = [
        { material: { name: { contains: query.search, mode: 'insensitive' } } },
        { material: { materialCode: { contains: query.search, mode: 'insensitive' } } },
        { supplierName: { contains: query.search, mode: 'insensitive' } },
        { documentNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.materialStockMovement.findMany({
            where,
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
            include: { material: { select: { materialCode: true, name: true, unit: true, category: true } } },
          }),
          this.prisma.materialStockMovement.count({ where }),
        ]);
        return { data, meta: { page, pageSize, total } };
      },
      () => ({ data: [], meta: { page, pageSize, total: 0 } }),
    );
  }

  @Post('materials/movements')
  @Roles('warehouse_material', 'admin')
  @ApiOperation({ summary: 'Record material stock movement' })
  async postMaterialMovement(@Body() body: any) {
    const mat = await this.prisma.material.findUnique({ where: { id: body.materialId } });
    if (!mat) throw new NotFoundException({ code: 'NOT_FOUND', message: `Material ${body.materialId} not found` });

    const isExpense = body.movementType === 'EXPENSE' || body.movementType === 'TO_PRODUCTION';
    const qtyChange = isExpense ? -Math.abs(body.qty) : Math.abs(body.qty);

    const movement = await this.prisma.materialStockMovement.create({
      data: {
        itemId: body.materialId,
        movementType: body.movementType,
        qty: Math.abs(body.qty),
        unitPrice: body.unitPrice || mat.purchasePrice,
        movementDate: new Date(body.movementDate || Date.now()),
        project: body.project || null,
      }
    });

    await this.prisma.material.update({
      where: { id: body.materialId },
      data: { stockQty: { increment: qtyChange } }
    });

    // Расход гасит партии по FIFO — иначе «живой остаток» перестанет быть
    // живым и подбор цены начнёт предлагать давно израсходованное (09 §4.1).
    // Непокрытая часть не прячется: она уходит в ответ и видна в сверке.
    const batchConsumption = isExpense
      ? await this.batches.consumeFifo(body.materialId, Math.abs(body.qty))
      : null;

    return { ...movement, batchConsumption };
  }

  @Get('finished-goods/balance')
  @ApiOperation({ summary: 'Get finished goods stock balance' })
  async getFGBalance(@Query() query: { search?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 100;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { articleCode: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const articles = await this.prisma.article.findMany({
      where, skip, take: pageSize, orderBy: { name: 'asc' },
    });

    return articles.map(a => ({
      articleId: a.id,
      articleCode: a.articleCode,
      name: a.name,
      stockQty: 0,
      approvedPrice: Number(a.approvedPrice),
    }));
  }

  @Post('finished-goods/movements')
  @Roles('warehouse_fg', 'admin')
  @ApiOperation({ summary: 'Record finished goods movement' })
  async postFGMovement(@Body() body: any) {
    const article = await this.prisma.article.findUnique({ where: { id: body.articleId } });
    if (!article) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${body.articleId} not found` });

    // API принимает русские названия из исходной таблицы; Prisma ждёт имена enum
    const MOVEMENT_TYPE_MAP: Record<string, string> = {
      'приход': 'RECEIPT', 'расход': 'EXPENSE', 'в_производство': 'TO_PRODUCTION',
      'с_производства': 'FROM_PRODUCTION', 'возврат': 'RETURN', 'коррекция': 'CORRECTION',
      'отгрузка': 'SHIPMENT',
    };
    const movementType = MOVEMENT_TYPE_MAP[body.movementType] ?? body.movementType;

    return this.prisma.finishedGoodsMovement.create({
      data: {
        itemId: body.articleId,
        orderId: body.orderId ?? null,
        movementType,
        qty: body.qty,
        unitPrice: body.unitPrice || article.approvedPrice,
        movementDate: new Date(body.movementDate || Date.now()),
      }
    });
  }
}
