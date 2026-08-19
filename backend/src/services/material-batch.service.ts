import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { runWithFallback } from '../common/fallback';
import {
  resolvePrice, isPriceAnomaly, anomalyFactor, lastPurchasePriceOf,
  BatchLike, PriceRequest, PriceResolution,
} from '../common/material-batches';

/** Во сколько раз цена должна разойтись с медианой, чтобы уйти в карантин (09 §4.5) */
export const DEFAULT_ANOMALY_THRESHOLD = 5;

/**
 * Партии материалов (09 §4): приход = партия с собственной ценой и живым
 * остатком. Отсюда берётся цена для калькуляции и сюда же возвращается ссылка,
 * по которой через месяц видно, из какой именно партии сложилась цифра.
 */
@Injectable()
export class MaterialBatchService {
  constructor(private readonly prisma: PrismaService) {}

  /** Партии материала: сначала свежие — так их читает человек в интерфейсе */
  async batchesOf(materialId: string, includeEmpty = false): Promise<any[]> {
    return runWithFallback(
      this.prisma,
      () => this.prisma.materialBatch.findMany({
        where: { materialId, ...(includeEmpty ? {} : { qtyRemaining: { gt: 0 } }) },
        orderBy: { receiptDate: 'desc' },
      }),
      () => [],
    );
  }

  private toBatchLike(rows: any[]): BatchLike[] {
    return rows.map((b) => ({
      id: b.id,
      receiptDate: b.receiptDate,
      unitPrice: Number(b.unitPrice),
      qtyRemaining: Number(b.qtyRemaining),
      priceAnomaly: b.priceAnomaly,
    }));
  }

  /**
   * Цена под объём с раскладкой по партиям. Если партий нет вовсе (материал
   * ни разу не приходовали), падаем на учётную цену справочника — иначе
   * калькуляция обнулилась бы там, где раньше работала.
   */
  async priceFor(materialId: string, req: PriceRequest): Promise<PriceResolution> {
    const rows = await this.batchesOf(materialId, true);
    const batches = this.toBatchLike(rows);

    if (batches.length === 0) {
      const material = await runWithFallback(
        this.prisma,
        () => this.prisma.material.findUnique({ where: { id: materialId } }),
        () => null,
      );
      const fallback = material
        ? Number(material.lastPurchasePrice) || Number(material.purchasePrice)
        : 0;
      return resolvePrice([], { ...req, fallbackPrice: req.fallbackPrice ?? fallback });
    }
    return resolvePrice(batches, req);
  }

  /**
   * Списание в производство расходует партии по FIFO — иначе «живой остаток»
   * перестанет быть живым и подбор начнёт предлагать давно израсходованное.
   */
  async consumeFifo(materialId: string, qty: number, tx?: any) {
    const client = tx ?? this.prisma;
    const rows = await client.materialBatch.findMany({
      where: { materialId, qtyRemaining: { gt: 0 } },
      orderBy: [{ receiptDate: 'asc' }, { id: 'asc' }],
    });
    let left = qty;
    const consumed: Array<{ batchId: string; qty: number }> = [];
    for (const b of rows) {
      if (left <= 0) break;
      const take = Math.min(left, Number(b.qtyRemaining));
      if (take <= 0) continue;
      await client.materialBatch.update({
        where: { id: b.id },
        data: { qtyRemaining: { decrement: take } },
      });
      consumed.push({ batchId: b.id, qty: take });
      left = Math.round((left - take) * 1000) / 1000;
    }
    // Непокрытый расход не гасим: остаток ушёл в минус по факту, и это
    // расхождение должно быть видно в сверке, а не растворяться
    return { consumed, uncoveredQty: Math.max(0, left) };
  }

  /**
   * Партия из прихода. Идемпотентна по движению: повторная обработка того же
   * документа из 1С не создаёт вторую партию.
   */
  async createFromMovement(movement: {
    id: string;
    itemId: string;
    qty: number;
    unitPrice: number;
    movementDate: Date;
    supplierName?: string | null;
    documentNumber?: string | null;
  }, threshold = DEFAULT_ANOMALY_THRESHOLD) {
    const existing = await this.prisma.materialBatch.findUnique({
      where: { sourceMovementId: movement.id },
    });
    if (existing) return existing;

    // Сравниваем с уже проверенными партиями: одна ошибка ввода не должна
    // утаскивать за собой оценку следующих
    const healthy = await this.prisma.materialBatch.findMany({
      where: { materialId: movement.itemId, priceAnomaly: false },
      select: { unitPrice: true },
    });
    const others = healthy.map((b) => Number(b.unitPrice));
    const anomaly = isPriceAnomaly(movement.unitPrice, others, threshold);

    return this.prisma.materialBatch.create({
      data: {
        materialId: movement.itemId,
        receiptDate: movement.movementDate,
        unitPrice: movement.unitPrice,
        qtyReceived: movement.qty,
        qtyRemaining: movement.qty,
        supplierName: movement.supplierName ?? null,
        documentNumber: movement.documentNumber ?? null,
        sourceMovementId: movement.id,
        priceAnomaly: anomaly,
        anomalyFactor: anomaly ? anomalyFactor(movement.unitPrice, others) : null,
      },
    });
  }

  /** Экран «Материалы с подозрительными ценами» (09 §4.5) */
  async anomalyReport() {
    return runWithFallback(
      this.prisma,
      async () => {
        const rows = await this.prisma.materialBatch.findMany({
          where: { priceAnomaly: true, anomalyClearedAt: null },
          include: { material: { select: { id: true, materialCode: true, name: true, unit: true } } },
          orderBy: { anomalyFactor: 'desc' },
        });
        return rows.map((b) => ({
          batchId: b.id,
          material: b.material,
          receiptDate: b.receiptDate,
          unitPrice: Number(b.unitPrice),
          qtyRemaining: Number(b.qtyRemaining),
          anomalyFactor: b.anomalyFactor ? Number(b.anomalyFactor) : null,
          documentNumber: b.documentNumber,
          supplierName: b.supplierName,
          hint: 'Похоже на разные единицы измерения в одной номенклатуре',
        }));
      },
      () => [],
    );
  }

  /** Снабжение подтвердило цену — партия возвращается в автоподбор */
  async clearAnomaly(batchId: string, userId?: string) {
    return this.prisma.materialBatch.update({
      where: { id: batchId },
      data: {
        priceAnomaly: false,
        anomalyClearedAt: new Date(),
        anomalyClearedById: userId && !userId.startsWith('usr-') ? userId : null,
      },
    });
  }

  /**
   * Разовое наполнение партий из истории приходов. Идемпотентно:
   * повторный запуск не создаёт дублей.
   */
  async backfillFromMovements(threshold = DEFAULT_ANOMALY_THRESHOLD) {
    const movements = await this.prisma.materialStockMovement.findMany({
      where: { movementType: 'RECEIPT' as any, unitPrice: { gt: 0 } },
      orderBy: [{ itemId: 'asc' }, { movementDate: 'asc' }],
    });

    let created = 0;
    let anomalies = 0;
    const healthyByMaterial = new Map<string, number[]>();

    for (const m of movements) {
      const exists = await this.prisma.materialBatch.findUnique({
        where: { sourceMovementId: m.id },
      });
      if (exists) continue;

      const price = Number(m.unitPrice);
      const others = healthyByMaterial.get(m.itemId) ?? [];
      const anomaly = isPriceAnomaly(price, others, threshold);

      await this.prisma.materialBatch.create({
        data: {
          materialId: m.itemId,
          receiptDate: m.movementDate,
          unitPrice: price,
          qtyReceived: m.qty,
          // История: остаток восстановить нельзя, считаем партию израсходованной.
          // Живые остатки появятся с первого нового прихода — иначе мы бы
          // выдумали склад, которого нет.
          qtyRemaining: 0,
          supplierName: m.supplierName,
          documentNumber: m.documentNumber,
          sourceMovementId: m.id,
          priceAnomaly: anomaly,
          anomalyFactor: anomaly ? anomalyFactor(price, others) : null,
        },
      });
      created += 1;
      if (anomaly) anomalies += 1;
      else healthyByMaterial.set(m.itemId, [...others, price]);
    }

    return { created, anomalies, scanned: movements.length };
  }

  /** Последняя закупочная по партиям — для подписи и для цены дефицита */
  async lastPurchaseOf(materialId: string) {
    const rows = await this.batchesOf(materialId, true);
    return lastPurchasePriceOf(this.toBatchLike(rows).filter((b) => !b.priceAnomaly));
  }
}
