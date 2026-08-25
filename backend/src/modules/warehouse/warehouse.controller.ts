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

  /**
   * История цены закупа — «когда и почём брали» (запрос 25.08.2026).
   * Два источника, слитые в одну ленту: ручные приходы через этот же
   * контроллер пишут в material_stock_movements, а заливка из 1С
   * (import-1c-csv.ts) пишет партии сразу в material_batches, эту
   * таблицу не трогая. Экран был пуст не потому что истории нет —
   * он смотрел только в первую таблицу, где после сегодняшней заливки
   * реальных партий физически быть не может.
   */
  @Get('materials/:id/movements')
  @ApiOperation({ summary: 'История движений материала — за сколько и когда покупали' })
  async getMaterialMovements(@Param('id') id: string, @Query('limit') limit?: string) {
    const take = Number(limit) || 50;
    return runWithFallback(
      this.prisma,
      async () => {
        const [movements, batches] = await Promise.all([
          this.prisma.materialStockMovement.findMany({
            where: { itemId: id },
            orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
            take,
          }),
          this.prisma.materialBatch.findMany({
            where: { materialId: id },
            orderBy: { receiptDate: 'desc' },
            take,
          }),
        ]);
        const fromMovements = movements.map((m) => ({
          id: m.id,
          movementDate: m.movementDate,
          qty: m.qty,
          unitPrice: m.unitPrice,
          documentNumber: m.documentNumber,
          supplierName: m.supplierName,
          comment: m.comment,
          origin: 'MOVEMENT' as const,
          priceAnomaly: false,
        }));
        const fromBatches = batches.map((b) => ({
          id: b.id,
          movementDate: b.receiptDate,
          qty: b.qtyReceived,
          unitPrice: b.unitPrice,
          documentNumber: b.documentNumber,
          supplierName: b.supplierName,
          comment: b.origin === 'INVENTORY' ? 'Стартовый остаток (инвентаризация)' : null,
          origin: b.origin,
          priceAnomaly: b.priceAnomaly,
        }));
        return [...fromMovements, ...fromBatches]
          .sort((a, b) => new Date(b.movementDate).getTime() - new Date(a.movementDate).getTime())
          .slice(0, take);
      },
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

  @Post('materials/tolling-receipt')
  @Roles('warehouse_material', 'admin')
  @ApiOperation({ summary: 'Приход давальческого сырья: партия заказа, цена 0' })
  async postTollingReceipt(@Body() body: {
    materialId: string; orderId: string; qty: number;
    receiptDate?: string; documentNumber?: string; supplierName?: string;
  }) {
    const [mat, order] = await Promise.all([
      this.prisma.material.findUnique({ where: { id: body.materialId } }),
      this.prisma.order.findUnique({ where: { id: body.orderId } }),
    ]);
    if (!mat) throw new NotFoundException({ code: 'NOT_FOUND', message: `Material ${body.materialId} not found` });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${body.orderId} not found` });

    await this.prisma.material.update({
      where: { id: body.materialId },
      data: { stockQty: { increment: Math.abs(body.qty) } },
    });
    return this.batches.createTollingReceipt({
      materialId: body.materialId,
      orderId: body.orderId,
      qty: Math.abs(body.qty),
      receiptDate: body.receiptDate ? new Date(body.receiptDate) : undefined,
      documentNumber: body.documentNumber ?? null,
      supplierName: body.supplierName ?? null,
    });
  }

  /**
   * Движение материала. ПРИХОД здесь заводить нельзя (решение 23.08.2026):
   * сырьё приезжает из «Заказа поставщику» 1С вместе с фактической ценой,
   * и второй способ создать ту же партию — это расхождение склада с 1С,
   * которое потом никто не объяснит. Списание в производство остаётся:
   * в таком разрезе 1С учёт не ведёт.
   */
  @Post('materials/movements')
  @Roles('warehouse_material', 'admin')
  @ApiOperation({ summary: 'Списание материала в производство (приход — только из 1С)' })
  async postMaterialMovement(@Body() body: any) {
    const mat = await this.prisma.material.findUnique({ where: { id: body.materialId } });
    if (!mat) throw new NotFoundException({ code: 'NOT_FOUND', message: `Material ${body.materialId} not found` });

    const isExpense = body.movementType === 'EXPENSE' || body.movementType === 'TO_PRODUCTION';
    if (!isExpense) {
      throw new BadRequestException({
        code: 'RECEIPT_COMES_FROM_1C',
        message: 'Приход материала не заводится руками — он приходит из «Заказа поставщику» 1С с фактической ценой',
      });
    }
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
      ? await this.batches.consumeFifo(body.materialId, Math.abs(body.qty), undefined, body.orderId ?? null)
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
