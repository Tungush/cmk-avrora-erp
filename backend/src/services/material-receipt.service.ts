import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { CascadeRecalcService } from './cascade-recalc.service';
import { MaterialBatchService } from './material-batch.service';

export interface ReceiptInput {
  materialId: string;
  qty: number;
  unitPrice: number;
  movementDate?: string | Date;
  supplierName?: string | null;
  documentNumber?: string | null;
  comment?: string | null;
}

/**
 * Приход материала — единая точка для ручного ввода кладовщиком и для
 * документа «Поступление товаров», пришедшего из 1С (08_INTEGRATION_1C.md §4.4).
 *
 * Учётная цена — средневзвешенная по остатку: одна дорогая партия не должна
 * мгновенно задирать все калькуляции. Изменилась цена → каскад в себестоимость
 * всех изделий, где материал используется.
 */
@Injectable()
export class MaterialReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cascade: CascadeRecalcService,
    private readonly batches: MaterialBatchService,
  ) {}

  async receive(input: ReceiptInput, userId?: string) {
    const qty = Number(input.qty);
    const unitPrice = Number(input.unitPrice);
    if (!(qty > 0)) throw new BadRequestException({ code: 'INVALID_QTY', message: 'Количество должно быть > 0' });
    if (!(unitPrice >= 0)) throw new BadRequestException({ code: 'INVALID_PRICE', message: 'Цена не может быть отрицательной' });

    const material = await this.prisma.material.findUnique({ where: { id: input.materialId } });
    if (!material) throw new NotFoundException({ code: 'NOT_FOUND', message: `Material ${input.materialId} not found` });

    const stockBefore = Number(material.stockQty);
    const priceBefore = Number(material.purchasePrice);
    // При нулевом/отрицательном остатке средневзвешенная не имеет смысла — берём цену прихода
    const newAvgPrice = stockBefore > 0
      ? Math.round(((stockBefore * priceBefore + qty * unitPrice) / (stockBefore + qty)) * 100) / 100
      : unitPrice;
    const movementDate = new Date(input.movementDate || Date.now());

    const [movement, updatedMaterial] = await this.prisma.$transaction([
      this.prisma.materialStockMovement.create({
        data: {
          itemId: material.id,
          movementType: 'RECEIPT',
          qty,
          unitPrice,
          movementDate,
          supplierName: input.supplierName?.trim() || null,
          documentNumber: input.documentNumber?.trim() || null,
          comment: input.comment?.trim() || null,
        },
      }),
      this.prisma.material.update({
        where: { id: material.id },
        data: {
          stockQty: { increment: qty },
          purchasePrice: newAvgPrice,
          purchasePriceUpdatedAt: movementDate,
          lastPurchasePrice: unitPrice,
          lastPurchaseDate: movementDate,
        },
      }),
    ]);

    // Приход — это партия со своей ценой и живым остатком (09 §4.1).
    // Средневзвешенная остаётся как учётная, но калькуляция теперь может
    // считать по конкретной партии, а не по «средней температуре».
    const batch = await this.batches.createFromMovement({
      id: movement.id,
      itemId: material.id,
      qty,
      unitPrice,
      movementDate,
      supplierName: input.supplierName?.trim() || null,
      documentNumber: input.documentNumber?.trim() || null,
    });

    // Сколько изделий заденет пересчёт — видно сразу тому, кто заносит приход
    const affected = await this.prisma.bomItem.findMany({
      where: { materialId: material.id },
      select: { articleId: true },
      distinct: ['articleId'],
    });

    let recalculation: { jobId: string; status: string } | null = null;
    if (newAvgPrice !== priceBefore && affected.length > 0) {
      recalculation = this.cascade.enqueueMaterialPriceRecalc(material.id, userId);
    }

    return {
      movement,
      material: {
        id: updatedMaterial.id,
        materialCode: updatedMaterial.materialCode,
        name: updatedMaterial.name,
        unit: updatedMaterial.unit,
        stockQty: Number(updatedMaterial.stockQty),
      },
      price: {
        before: priceBefore,
        after: newAvgPrice,
        receipt: unitPrice,
        changed: newAvgPrice !== priceBefore,
      },
      batch: {
        id: batch.id,
        unitPrice: Number(batch.unitPrice),
        qtyRemaining: Number(batch.qtyRemaining),
        // Цена резко разошлась с медианой по материалу — партия в карантине
        // и в автоподбор не попадёт, пока снабжение не подтвердит (09 §4.5)
        priceAnomaly: batch.priceAnomaly,
        anomalyFactor: batch.anomalyFactor ? Number(batch.anomalyFactor) : null,
      },
      affectedArticles: affected.length,
      recalculation,
    };
  }
}
