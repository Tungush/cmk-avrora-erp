/**
 * Партии материала и выбор закупочной цены (09_COSTING_AND_STAGES.md §4).
 *
 * Справочник хранит одну учётную цену — «как сейчас». Но разброс между
 * приходами одного материала доходит до +37 % (лист г/к 20мм: 345 000 → 471 000
 * ₸/т за год), и заказ, посчитанный по разным партиям, отличается на треть.
 * Поэтому цена выбирается из партий, а выбор замораживается в снимке вместе
 * со ссылкой на конкретный приход.
 */

export type PriceSourceValue =
  | 'FIFO_STOCK'
  | 'SPECIFIC_BATCH'
  | 'WEIGHTED_AVG'
  | 'LAST_PURCHASE'
  | 'PRICE_LIST'
  | 'MANUAL';

export interface BatchLike {
  id: string;
  receiptDate: Date | string;
  unitPrice: number;
  qtyRemaining: number;
  priceAnomaly?: boolean;
}

export interface BatchAllocation {
  batchId: string;
  qty: number;
  unitPrice: number;
  lineCost: number;
}

export interface PriceRequest {
  qty: number;
  source: PriceSourceValue;
  /** Для SPECIFIC_BATCH */
  batchId?: string | null;
  /** Для PRICE_LIST и MANUAL */
  explicitPrice?: number | null;
  /** Чем считать дефицит: прогнозная цена закупа; по умолчанию — последняя закупочная */
  fallbackPrice?: number | null;
  /** Снабжение подтвердило подозрительные партии — можно считать по ним */
  allowAnomalies?: boolean;
}

export interface PriceResolution {
  source: PriceSourceValue;
  /** Средневзвешенная по факту покрытия — то, что уйдёт в строку калькуляции */
  unitPrice: number;
  totalCost: number;
  allocations: BatchAllocation[];
  coveredQty: number;
  shortageQty: number;
  shortageUnitPrice: number;
  shortageCost: number;
  /** Часть объёма посчитана по цене, которой на складе нет (09 §4.3) */
  isShortage: boolean;
  /** Партии, отсечённые карантином (09 §4.5) */
  excludedAnomalyBatchIds: string[];
  /** На чём основана цена — для подписи в разборе формулы */
  basis: 'batches' | 'explicit' | 'last_purchase' | 'none';
}

export class BatchSelectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BatchSelectionError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const time = (d: Date | string) => new Date(d).getTime();

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Во сколько раз цена расходится с медианой по материалу — в любую сторону.
 * null, если сравнивать не с чем: одна партия не бывает аномальной.
 */
export function anomalyFactor(price: number, otherPrices: number[]): number | null {
  const base = median(otherPrices.filter((p) => p > 0));
  if (base <= 0 || price <= 0) return null;
  return round2(Math.max(price / base, base / price));
}

/**
 * Карантин цены (09 §4.5). Порог 5× ловит перепутанные единицы измерения
 * («труба» с приходами по 2 548 и по 430 000 — это цена за метр против цены
 * за тонну), но не трогает обычный рыночный разброс в 25–37 %.
 *
 * Сравнение идёт с медианой уже проверенных партий: одна ошибка не должна
 * утаскивать за собой оценку следующих.
 */
export function isPriceAnomaly(price: number, otherPrices: number[], threshold = 5): boolean {
  const factor = anomalyFactor(price, otherPrices);
  return factor !== null && factor > threshold;
}

/** Цена последнего прихода — «за сколько купили в последний раз» */
export function lastPurchasePriceOf(batches: BatchLike[]): { price: number; batchId: string | null } {
  if (batches.length === 0) return { price: 0, batchId: null };
  const latest = [...batches].sort((a, b) => time(b.receiptDate) - time(a.receiptDate))[0];
  return { price: latest.unitPrice, batchId: latest.id };
}

/**
 * Подбор цены под требуемый объём. Возвращает не только цифру, но и то,
 * из каких партий она сложилась: без этого через месяц не ответить, почему
 * стало дороже, — а именно за этим всё и затевалось.
 */
export function resolvePrice(batches: BatchLike[], req: PriceRequest): PriceResolution {
  const qty = Math.max(0, req.qty);
  const allowAnomalies = req.allowAnomalies ?? false;

  const excludedAnomalyBatchIds = batches
    .filter((b) => b.priceAnomaly && !allowAnomalies && b.qtyRemaining > 0)
    .map((b) => b.id);

  const usable = batches.filter(
    (b) => b.qtyRemaining > 0 && (allowAnomalies || !b.priceAnomaly),
  );

  const fallback = req.fallbackPrice ?? lastPurchasePriceOf(
    allowAnomalies ? batches : batches.filter((b) => !b.priceAnomaly),
  ).price;

  const finish = (
    allocations: BatchAllocation[],
    basis: PriceResolution['basis'],
  ): PriceResolution => {
    const coveredQty = round3(allocations.reduce((s, a) => s + a.qty, 0));
    const shortageQty = round3(Math.max(0, qty - coveredQty));
    const shortageUnitPrice = shortageQty > 0 ? round2(fallback) : 0;
    const shortageCost = round2(shortageQty * shortageUnitPrice);
    const totalCost = round2(allocations.reduce((s, a) => s + a.lineCost, 0) + shortageCost);
    return {
      source: req.source,
      unitPrice: qty > 0 ? round2(totalCost / qty) : 0,
      totalCost,
      allocations,
      coveredQty,
      shortageQty,
      shortageUnitPrice,
      shortageCost,
      isShortage: shortageQty > 0,
      excludedAnomalyBatchIds,
      basis,
    };
  };

  /** Цена без привязки к остаткам: весь объём по одной ставке */
  const flat = (price: number, basis: PriceResolution['basis']): PriceResolution => {
    const totalCost = round2(qty * price);
    return {
      source: req.source,
      unitPrice: round2(price),
      totalCost,
      allocations: [],
      coveredQty: qty,
      shortageQty: 0,
      shortageUnitPrice: 0,
      shortageCost: 0,
      isShortage: false,
      excludedAnomalyBatchIds,
      basis,
    };
  };

  switch (req.source) {
    case 'MANUAL':
    case 'PRICE_LIST': {
      if (req.explicitPrice == null) {
        throw new BatchSelectionError(
          'EXPLICIT_PRICE_REQUIRED',
          `Для источника ${req.source} нужно указать цену`,
        );
      }
      return flat(req.explicitPrice, 'explicit');
    }

    case 'LAST_PURCHASE': {
      const { price } = lastPurchasePriceOf(allowAnomalies ? batches : batches.filter((b) => !b.priceAnomaly));
      return flat(price, price > 0 ? 'last_purchase' : 'none');
    }

    case 'SPECIFIC_BATCH': {
      if (!req.batchId) {
        throw new BatchSelectionError('BATCH_REQUIRED', 'Не указана партия');
      }
      const batch = batches.find((b) => b.id === req.batchId);
      if (!batch) {
        throw new BatchSelectionError('BATCH_NOT_FOUND', `Партия ${req.batchId} не найдена`);
      }
      if (batch.priceAnomaly && !allowAnomalies) {
        throw new BatchSelectionError(
          'BATCH_IN_QUARANTINE',
          'Партия на карантине по цене — нужно подтверждение снабжения',
        );
      }
      const take = round3(Math.min(qty, Math.max(0, batch.qtyRemaining)));
      const allocations = take > 0
        ? [{ batchId: batch.id, qty: take, unitPrice: batch.unitPrice, lineCost: round2(take * batch.unitPrice) }]
        : [];
      return finish(allocations, take > 0 ? 'batches' : 'none');
    }

    case 'WEIGHTED_AVG': {
      const totalRemaining = usable.reduce((s, b) => s + b.qtyRemaining, 0);
      if (totalRemaining <= 0) return finish([], 'none');
      const avg = usable.reduce((s, b) => s + b.qtyRemaining * b.unitPrice, 0) / totalRemaining;
      const covered = round3(Math.min(qty, totalRemaining));
      // Одна строка по средней: смысл режима — не тянуть конкретные партии,
      // а взять усреднённую цену остатков
      const allocations = covered > 0
        ? [{ batchId: '', qty: covered, unitPrice: round2(avg), lineCost: round2(covered * avg) }]
        : [];
      return finish(allocations, covered > 0 ? 'batches' : 'none');
    }

    case 'FIFO_STOCK':
    default: {
      // Старые партии первыми; при равной дате порядок по id — расчёт должен
      // быть воспроизводимым, иначе две калькуляции одного заказа разойдутся
      const queue = [...usable].sort(
        (a, b) => time(a.receiptDate) - time(b.receiptDate) || a.id.localeCompare(b.id),
      );
      const allocations: BatchAllocation[] = [];
      let left = qty;
      for (const b of queue) {
        if (left <= 0) break;
        const take = round3(Math.min(left, b.qtyRemaining));
        if (take <= 0) continue;
        allocations.push({
          batchId: b.id,
          qty: take,
          unitPrice: b.unitPrice,
          lineCost: round2(take * b.unitPrice),
        });
        left = round3(left - take);
      }
      return finish(allocations, allocations.length > 0 ? 'batches' : 'none');
    }
  }
}
