import { Controller, Get, Post, Param, Body, NotFoundException, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { OrderCostingService, BuildCostingOptions } from '../../services/order-costing.service';
import { compareCostings, reconcile, CostingSnapshot } from '../../common/costing-compare';

/** Строка БД → снимок для факторного разбора */
function toSnapshot(c: any): CostingSnapshot {
  return {
    version: c.version,
    calculatedAt: c.calculatedAt,
    qty: Number(c.qty),
    materialCost: Number(c.materialCost),
    laborCost: Number(c.laborCost),
    logisticsCost: Number(c.logisticsCost),
    utilitiesCost: Number(c.utilitiesCost),
    totalCost: Number(c.totalCost),
    margin: Number(c.margin),
    price: Number(c.price),
    logisticsPct: Number(c.logisticsPct),
    logisticsMode: c.logisticsMode,
    utilitiesPct: Number(c.utilitiesPct),
    marginPct: Number(c.marginPct),
    marginMode: c.marginMode,
    materials: (c.materials ?? []).map((m: any) => ({
      materialId: m.materialId,
      name: m.materialNameSnapshot,
      qtyTotal: Number(m.qtyTotal),
      unitPrice: Number(m.unitPrice),
      lineCost: Number(m.lineCost),
      batchId: m.batchId,
      priceDate: m.priceDate,
    })),
    labor: (c.labor ?? []).map((l: any) => ({
      stage: l.stage,
      laborKind: l.laborKind,
      rateType: l.rateType,
      rate: Number(l.rate),
      manHours: Number(l.manHours),
      lineCost: Number(l.lineCost),
      contractorId: l.contractorId,
    })),
  };
}

/**
 * Калькуляция позиции заказа (09 §3, §6): версии-документы и разбор,
 * почему тот же заказ через месяц стоит других денег.
 */
@ApiTags('Order Costings')
@ApiBearerAuth()
@Controller('order-lines/:orderLineId/costings')
export class OrderCostingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly costings: OrderCostingService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Версии калькуляции позиции заказа' })
  async list(@Param('orderLineId') orderLineId: string) {
    const rows = await this.costings.versionsOf(orderLineId);
    return {
      data: rows.map((c) => ({
        id: c.id,
        version: c.version,
        status: c.status,
        calculatedAt: c.calculatedAt,
        approvedAt: c.approvedAt,
        totalCost: Number(c.totalCost),
        price: Number(c.price),
        marginMode: c.marginMode,
        marginPct: Number(c.marginPct),
        ratesSource: c.ratesSource,
        ratesReason: c.ratesReason,
        hasShortage: c.hasShortage,
        hasMissingNorm: c.hasMissingNorm,
        hasMissingBom: c.hasMissingBom,
        materialsCount: c.materials.length,
      })),
      total: rows.length,
    };
  }

  /**
   * Одна версия целиком: материалы со стадией цены и партией, труд с
   * подрядчиком. list() отдаёт только сводку — здесь то, из чего она
   * сложилась (для карточки заказа и для водопада «почему подорожало»).
   */
  @Get(':costingId')
  @ApiOperation({ summary: 'Калькуляция целиком: материалы со стадией цены, труд' })
  async getOne(@Param('costingId') costingId: string) {
    const c = await this.prisma.orderCosting.findUnique({
      where: { id: costingId },
      include: { materials: true, labor: { include: { contractor: { select: { id: true, name: true } } } } },
    });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: `Калькуляция ${costingId} не найдена` });

    const batchIds = [...new Set(c.materials.map((m) => m.batchId).filter(Boolean))] as string[];
    const batches = batchIds.length
      ? await this.prisma.materialBatch.findMany({
          where: { id: { in: batchIds } },
          select: { id: true, receiptDate: true, documentNumber: true, supplierName: true, batchType: true },
        })
      : [];
    const batchById = new Map(batches.map((b) => [b.id, b]));

    return {
      id: c.id,
      version: c.version,
      status: c.status,
      calculatedAt: c.calculatedAt,
      approvedAt: c.approvedAt,
      materialCost: Number(c.materialCost),
      laborCost: Number(c.laborCost),
      contractorCost: Number(c.contractorCost),
      logisticsCost: Number(c.logisticsCost),
      utilitiesCost: Number(c.utilitiesCost),
      totalCost: Number(c.totalCost),
      margin: Number(c.margin),
      price: Number(c.price),
      marginPct: Number(c.marginPct),
      hasShortage: c.hasShortage,
      hasMissingNorm: c.hasMissingNorm,
      hasMissingBom: c.hasMissingBom,
      materials: c.materials.map((m) => ({
        id: m.id,
        materialCode: m.materialCodeSnapshot,
        materialName: m.materialNameSnapshot,
        qtyTotal: Number(m.qtyTotal),
        unitPrice: Number(m.unitPrice),
        lineCost: Number(m.lineCost),
        priceState: m.priceState,
        supplierOrderNumber: m.supplierOrderNumber,
        priceStateChangedAt: m.priceStateChangedAt,
        isShortage: m.isShortage,
        batch: m.batchId ? batchById.get(m.batchId) ?? null : null,
      })),
      labor: c.labor.map((l) => ({
        id: l.id,
        stage: l.stage,
        laborKind: l.laborKind,
        contractor: l.contractor,
        share: Number(l.share),
        rateType: l.rateType,
        rate: Number(l.rate),
        manHours: Number(l.manHours),
        lineCost: Number(l.lineCost),
      })),
    };
  }

  @Post()
  @Roles('planner', 'sales_manager', 'procurement', 'admin')
  @ApiOperation({ summary: 'Посчитать новую версию калькуляции' })
  async build(
    @Param('orderLineId') orderLineId: string,
    @Body() body: BuildCostingOptions,
    @CurrentUser() user: UserPayload,
  ) {
    return this.costings.build(orderLineId, body ?? {}, user?.userId);
  }

  @Post(':costingId/approve')
  @Roles('director', 'planner', 'admin')
  @ApiOperation({ summary: 'Согласовать версию; прежняя уходит в архив' })
  async approve(
    @Param('costingId') costingId: string,
    @CurrentUser() user: UserPayload,
  ) {
    return this.costings.approve(costingId, user?.userId);
  }

  /**
   * Снабжение отметило: материал заказан у поставщика. Цена строки
   * замещается ценой из «Заказа поставщику» 1С и получает стадию ORDERED —
   * промежуточную между оценкой и фактом прихода (решение 22.08.2026).
   */
  @Post(':costingId/materials/:rowId/ordered')
  @Roles('planner', 'sales_manager', 'admin')
  @ApiOperation({ summary: 'Стадия цены «заказано»: цена из заказа поставщику 1С' })
  async markOrdered(
    @Param('costingId') costingId: string,
    @Param('rowId') rowId: string,
    @Body() body: { supplierOrderNumber: string; unitPrice?: number },
  ) {
    if (!body.supplierOrderNumber?.trim()) {
      throw new BadRequestException({
        code: 'MISSING_SUPPLIER_ORDER',
        message: 'Укажите номер заказа поставщику — без него стадия «заказано» не имеет следа',
      });
    }
    const row = await this.prisma.orderCostingMaterial.findUnique({ where: { id: rowId } });
    if (!row || row.costingId !== costingId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Строка ${rowId} в калькуляции ${costingId} не найдена` });
    }
    if (row.priceState === 'ACTUAL') {
      throw new BadRequestException({
        code: 'ALREADY_ACTUAL',
        message: 'Цена уже фактическая (партия пришла) — стадия «заказано» позади',
      });
    }
    const unitPrice = body.unitPrice ?? Number(row.unitPrice);
    return this.prisma.orderCostingMaterial.update({
      where: { id: rowId },
      data: {
        priceState: 'ORDERED',
        supplierOrderNumber: body.supplierOrderNumber.trim().slice(0, 30),
        priceStateChangedAt: new Date(),
        unitPrice,
        lineCost: Math.round(unitPrice * Number(row.qtyTotal) * 100) / 100,
      },
    });
  }

  /**
   * «Почему через месяц дороже»: разложение разницы на рост цен, изменение
   * состава, ставку, норму и смену исполнителя (09 §6).
   */
  @Get('compare/:baseId/:targetId')
  @ApiOperation({ summary: 'Факторный разбор разницы между версиями' })
  async compare(
    @Param('baseId') baseId: string,
    @Param('targetId') targetId: string,
  ) {
    const [base, target] = await Promise.all([
      this.prisma.orderCosting.findUnique({ where: { id: baseId }, include: { materials: true, labor: true } }),
      this.prisma.orderCosting.findUnique({ where: { id: targetId }, include: { materials: true, labor: true } }),
    ]);
    if (!base || !target) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Одна из версий калькуляции не найдена' });
    }
    if (base.orderLineId !== target.orderLineId) {
      throw new BadRequestException({
        code: 'DIFFERENT_ORDER_LINES',
        message: 'Сравнивать можно только версии одной позиции заказа',
      });
    }

    const result = compareCostings(toSnapshot(base), toSnapshot(target));
    // Разбор, который не сходится с итогом, хуже отсутствия разбора
    const residual = reconcile(result);
    return { ...result, residual };
  }
}
