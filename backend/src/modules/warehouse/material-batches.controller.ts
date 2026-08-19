import { Controller, Get, Post, Param, Query, Body, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { MaterialBatchService } from '../../services/material-batch.service';
import { PriceSourceValue } from '../../common/material-batches';

const PRICE_SOURCES: PriceSourceValue[] = [
  'FIFO_STOCK', 'SPECIFIC_BATCH', 'WEIGHTED_AVG', 'LAST_PURCHASE', 'PRICE_LIST', 'MANUAL',
];

/**
 * Партии материалов (09 §4). Отдельный от материалов ресурс: партия — это
 * документ прихода со своей ценой, а не свойство справочника.
 */
@ApiTags('Material Batches')
@ApiBearerAuth()
@Controller('material-batches')
export class MaterialBatchesController {
  constructor(private readonly batches: MaterialBatchService) {}

  @Get('anomalies')
  @ApiOperation({ summary: 'Материалы с подозрительными ценами (карантин)' })
  async anomalies() {
    const rows = await this.batches.anomalyReport();
    return { data: rows, total: rows.length };
  }

  @Post('anomalies/:batchId/clear')
  @Roles('procurement', 'planner', 'admin')
  @ApiOperation({ summary: 'Подтвердить цену партии — вернуть её в автоподбор' })
  async clearAnomaly(@Param('batchId') batchId: string, @CurrentUser() user: UserPayload) {
    return this.batches.clearAnomaly(batchId, user?.userId);
  }

  @Post('backfill')
  @Roles('admin')
  @ApiOperation({ summary: 'Разово наполнить партии из истории приходов (идемпотентно)' })
  async backfill() {
    return this.batches.backfillFromMovements();
  }

  @Get(':materialId')
  @ApiOperation({ summary: 'Партии материала с живыми остатками' })
  async list(
    @Param('materialId') materialId: string,
    @Query('includeEmpty') includeEmpty?: string,
  ) {
    const rows = await this.batches.batchesOf(materialId, includeEmpty === 'true');
    return {
      data: rows.map((b: any) => ({
        id: b.id,
        receiptDate: b.receiptDate,
        unitPrice: Number(b.unitPrice),
        qtyReceived: Number(b.qtyReceived),
        qtyRemaining: Number(b.qtyRemaining),
        supplierName: b.supplierName,
        documentNumber: b.documentNumber,
        origin: b.origin,
        priceAnomaly: b.priceAnomaly,
        anomalyFactor: b.anomalyFactor ? Number(b.anomalyFactor) : null,
      })),
      totalRemaining: rows.reduce((s: number, b: any) => s + Number(b.qtyRemaining), 0),
    };
  }

  /**
   * Предпросмотр цены до сохранения калькуляции: сколько выйдет по выбранному
   * источнику, из каких партий и сколько объёма не покрыто складом.
   */
  @Post(':materialId/price')
  @ApiOperation({ summary: 'Подобрать цену под объём по выбранному источнику' })
  async price(
    @Param('materialId') materialId: string,
    @Body() body: {
      qty: number;
      source?: PriceSourceValue;
      batchId?: string | null;
      explicitPrice?: number | null;
      fallbackPrice?: number | null;
      allowAnomalies?: boolean;
    },
  ) {
    const source = body.source ?? 'FIFO_STOCK';
    if (!PRICE_SOURCES.includes(source)) {
      throw new BadRequestException({
        code: 'INVALID_PRICE_SOURCE',
        message: `Неизвестный источник цены: ${source}. Допустимо: ${PRICE_SOURCES.join(', ')}`,
      });
    }
    if (!(Number(body.qty) > 0)) {
      throw new BadRequestException({ code: 'INVALID_QTY', message: 'Количество должно быть > 0' });
    }
    return this.batches.priceFor(materialId, { ...body, qty: Number(body.qty), source });
  }
}
