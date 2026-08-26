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

  /**
   * Партии материала: сначала свежие — так их читает человек в интерфейсе.
   * Давальческие партии видит только заказ-владелец (forOrderId): чужой металл
   * не должен даже показываться как доступный.
   */
  async batchesOf(materialId: string, includeEmpty = false, forOrderId?: string | null): Promise<any[]> {
    return runWithFallback(
      this.prisma,
      () => this.prisma.materialBatch.findMany({
        where: {
          materialId,
          ...(includeEmpty ? {} : { qtyRemaining: { gt: 0 } }),
          OR: [
            { batchType: 'OWN' as any },
            ...(forOrderId ? [{ batchType: 'TOLLING' as any, ownerOrderId: forOrderId }] : []),
          ],
        },
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
  async priceFor(materialId: string, req: PriceRequest, forOrderId?: string | null): Promise<PriceResolution> {
    const rows = await this.batchesOf(materialId, true, forOrderId);
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
  async consumeFifo(materialId: string, qty: number, tx?: any, forOrderId?: string | null) {
    const client = tx ?? this.prisma;
    const fetched = await client.materialBatch.findMany({
      where: {
        materialId,
        qtyRemaining: { gt: 0 },
        OR: [
          { batchType: 'OWN' },
          ...(forOrderId ? [{ batchType: 'TOLLING', ownerOrderId: forOrderId }] : []),
        ],
      },
      orderBy: [{ receiptDate: 'asc' }, { id: 'asc' }],
    });
    // Давальческий металл заказа расходуется первым: он принесён под этот
    // заказ, и пока он лежит, свой металл со склада трогать не надо
    const rows = [
      ...fetched.filter((b: any) => b.batchType === 'TOLLING'),
      ...fetched.filter((b: any) => b.batchType !== 'TOLLING'),
    ];
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
    batchType?: 'OWN' | 'TOLLING';
    ownerOrderId?: string | null;
  }, threshold = DEFAULT_ANOMALY_THRESHOLD) {
    const existing = await this.prisma.materialBatch.findUnique({
      where: { sourceMovementId: movement.id },
    });
    if (existing) return existing;

    const isTolling = movement.batchType === 'TOLLING';

    // Сравниваем с уже проверенными партиями: одна ошибка ввода не должна
    // утаскивать за собой оценку следующих. Давальческие с их нулевой ценой
    // в сравнении не участвуют и в карантин не попадают.
    const healthy = await this.prisma.materialBatch.findMany({
      where: { materialId: movement.itemId, priceAnomaly: false, batchType: 'OWN' as any },
      select: { unitPrice: true },
    });
    const others = healthy.map((b) => Number(b.unitPrice));
    const anomaly = !isTolling && isPriceAnomaly(movement.unitPrice, others, threshold);

    return this.prisma.materialBatch.create({
      data: {
        materialId: movement.itemId,
        receiptDate: movement.movementDate,
        unitPrice: isTolling ? 0 : movement.unitPrice,
        qtyReceived: movement.qty,
        qtyRemaining: movement.qty,
        supplierName: movement.supplierName ?? null,
        documentNumber: movement.documentNumber ?? null,
        sourceMovementId: movement.id,
        batchType: (movement.batchType ?? 'OWN') as any,
        ownerOrderId: isTolling ? movement.ownerOrderId ?? null : null,
        priceAnomaly: anomaly,
        anomalyFactor: anomaly ? anomalyFactor(movement.unitPrice, others) : null,
      },
    });
  }

  /**
   * Приход давальческого сырья вручную: пока не подтверждено, что 1С ведёт
   * давальческий склад (счёт 002), кладовщик фиксирует его у нас.
   * Партия принадлежит заказу, цена 0 — в себестоимость не попадает.
   */
  async createTollingReceipt(input: {
    materialId: string;
    orderId: string;
    qty: number;
    receiptDate?: Date;
    documentNumber?: string | null;
    supplierName?: string | null;
  }) {
    const movement = await this.prisma.materialStockMovement.create({
      data: {
        itemId: input.materialId,
        movementType: 'RECEIPT' as any,
        qty: input.qty,
        unitPrice: 0,
        movementDate: input.receiptDate ?? new Date(),
        project: null,
      },
    });
    return this.createFromMovement({
      id: movement.id,
      itemId: input.materialId,
      qty: input.qty,
      unitPrice: 0,
      movementDate: movement.movementDate,
      supplierName: input.supplierName ?? null,
      documentNumber: input.documentNumber ?? null,
      batchType: 'TOLLING',
      ownerOrderId: input.orderId,
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

  /** Последняя закупочная по партиям — для подписи и для цены дефицита.
   *  Только свои партии: нулевая цена давальческих — не закупочная цена. */
  /**
   * Обеспеченность заказа сырьём — read-only, ничего не создаёт (26.08.2026).
   *
   * Раньше «хватает / не хватает» существовало только как побочный эффект
   * создания версии калькуляции. Цеху нужен ответ до начала работ, без
   * записи в базу. Потребность — BOM всех позиций × количество, с
   * СУММИРОВАНИЕМ по материалу (в BOM один материал может стоять в
   * нескольких операциях — без суммирования один болт давал бы N строк
   * дефицита). Покрытие — живые партии (qtyRemaining > 0, без карантина
   * цен) минус ACTIVE-резервы чужих заказов.
   */
  async orderMaterialAvailability(orderId: string) {
    const lines = await this.prisma.orderLine.findMany({
      where: { orderId, articleId: { not: null } },
      select: {
        qty: true,
        article: {
          select: {
            isMaterialResale: true,
            bomItems: { select: { materialId: true, qtyPerUnit: true } },
          },
        },
      },
    });

    // Потребность по материалам: Σ (qtyPerUnit × qty позиции)
    const need = new Map<string, number>();
    for (const l of lines) {
      if (!l.article || l.article.isMaterialResale) continue;
      for (const b of l.article.bomItems) {
        need.set(b.materialId, (need.get(b.materialId) ?? 0) + Number(b.qtyPerUnit) * Number(l.qty));
      }
    }
    if (need.size === 0) {
      return { ok: true, checkedMaterials: 0, shortages: [], note: 'У позиций заказа нет состава — проверять нечего' };
    }

    const materialIds = [...need.keys()];
    const [batches, reservations, materials] = await Promise.all([
      this.prisma.materialBatch.findMany({
        where: { materialId: { in: materialIds }, qtyRemaining: { gt: 0 }, priceAnomaly: false },
        select: { id: true, materialId: true, qtyRemaining: true },
      }),
      this.prisma.batchReservation.findMany({
        where: { status: 'ACTIVE', batch: { materialId: { in: materialIds } } },
        select: { batchId: true, orderId: true, qty: true, batch: { select: { materialId: true } } },
      }),
      this.prisma.material.findMany({
        where: { id: { in: materialIds } },
        select: { id: true, materialCode: true, name: true, unit: true, purchasePrice: true, lastPurchasePrice: true },
      }),
    ]);

    const availableByMaterial = new Map<string, number>();
    for (const b of batches) {
      const reservedByOthers = reservations
        .filter((r) => r.batchId === b.id && r.orderId !== orderId)
        .reduce((s, r) => s + Number(r.qty), 0);
      const free = Math.max(0, Number(b.qtyRemaining) - reservedByOthers);
      availableByMaterial.set(b.materialId, (availableByMaterial.get(b.materialId) ?? 0) + free);
    }

    const matById = new Map(materials.map((m) => [m.id, m]));
    const shortages: Array<{
      materialId: string; materialCode: string; name: string; unit: string;
      need: number; available: number; shortage: number; estimatedPrice: number;
    }> = [];
    for (const [materialId, needQty] of need) {
      const available = availableByMaterial.get(materialId) ?? 0;
      if (available + 1e-9 >= needQty) continue;
      const m = matById.get(materialId);
      shortages.push({
        materialId,
        materialCode: m?.materialCode ?? '—',
        name: m?.name ?? '—',
        unit: m?.unit ?? 'шт',
        need: Math.round(needQty * 1000) / 1000,
        available: Math.round(available * 1000) / 1000,
        shortage: Math.round((needQty - available) * 1000) / 1000,
        estimatedPrice: Number(m?.lastPurchasePrice ?? m?.purchasePrice ?? 0),
      });
    }
    shortages.sort((a, b) => b.shortage * b.estimatedPrice - a.shortage * a.estimatedPrice);
    return { ok: shortages.length === 0, checkedMaterials: need.size, shortages };
  }

  async lastPurchaseOf(materialId: string) {
    const rows = (await this.batchesOf(materialId, true)).filter((b) => b.batchType !== 'TOLLING');
    return lastPurchasePriceOf(this.toBatchLike(rows).filter((b) => !b.priceAnomaly));
  }
}
