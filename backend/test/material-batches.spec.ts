import {
  resolvePrice, median, anomalyFactor, isPriceAnomaly, lastPurchasePriceOf,
  BatchLike, BatchSelectionError,
} from '../src/common/material-batches';

/** Реальный случай из базы: лист г/к 20мм, три прихода за год */
const BATCHES: BatchLike[] = [
  { id: 'b-apr', receiptDate: '2026-04-15', unitPrice: 345, qtyRemaining: 90 },
  { id: 'b-jun', receiptDate: '2026-06-03', unitPrice: 408, qtyRemaining: 500 },
  { id: 'b-jul', receiptDate: '2026-07-12', unitPrice: 471, qtyRemaining: 800 },
];

describe('FIFO по остаткам — режим по умолчанию (09 §4.2)', () => {
  it('старые партии расходуются первыми', () => {
    const r = resolvePrice(BATCHES, { qty: 1240, source: 'FIFO_STOCK' });
    expect(r.allocations.map((a) => [a.batchId, a.qty])).toEqual([
      ['b-apr', 90], ['b-jun', 500], ['b-jul', 650],
    ]);
  });

  it('итог совпадает с ручным расчётом 90×345 + 500×408 + 650×471', () => {
    const r = resolvePrice(BATCHES, { qty: 1240, source: 'FIFO_STOCK' });
    expect(r.totalCost).toBe(90 * 345 + 500 * 408 + 650 * 471);
    expect(r.unitPrice).toBe(436.45);
    expect(r.isShortage).toBe(false);
  });

  it('порядок не зависит от порядка записей на входе — расчёт воспроизводим', () => {
    const shuffled = [BATCHES[2], BATCHES[0], BATCHES[1]];
    expect(resolvePrice(shuffled, { qty: 1240, source: 'FIFO_STOCK' }).totalCost)
      .toBe(resolvePrice(BATCHES, { qty: 1240, source: 'FIFO_STOCK' }).totalCost);
  });

  it('партии с нулевым остатком пропускаются', () => {
    const empty = [{ id: 'b-0', receiptDate: '2026-01-01', unitPrice: 100, qtyRemaining: 0 }, ...BATCHES];
    const r = resolvePrice(empty, { qty: 50, source: 'FIFO_STOCK' });
    expect(r.allocations).toEqual([{ batchId: 'b-apr', qty: 50, unitPrice: 345, lineCost: 17250 }]);
  });
});

describe('Дефицит остатков не прячется (09 §4.3)', () => {
  it('непокрытый объём считается по последней закупочной и помечается', () => {
    const r = resolvePrice(BATCHES, { qty: 1500, source: 'FIFO_STOCK' });
    expect(r.coveredQty).toBe(1390);
    expect(r.shortageQty).toBe(110);
    expect(r.shortageUnitPrice).toBe(471);
    expect(r.isShortage).toBe(true);
  });

  it('прогнозная цена снабжения перебивает последнюю закупочную', () => {
    const r = resolvePrice(BATCHES, { qty: 1500, source: 'FIFO_STOCK', fallbackPrice: 520 });
    expect(r.shortageUnitPrice).toBe(520);
    expect(r.shortageCost).toBe(110 * 520);
  });

  it('пустой склад: весь объём — дефицит, а не нулевая цена', () => {
    const r = resolvePrice([], { qty: 100, source: 'FIFO_STOCK', fallbackPrice: 400 });
    expect(r.isShortage).toBe(true);
    expect(r.shortageQty).toBe(100);
    expect(r.totalCost).toBe(40000);
  });
});

describe('Остальные источники цены', () => {
  it('SPECIFIC_BATCH берёт только указанную партию, остальное — дефицит', () => {
    const r = resolvePrice(BATCHES, { qty: 200, source: 'SPECIFIC_BATCH', batchId: 'b-apr' });
    expect(r.allocations).toHaveLength(1);
    expect(r.coveredQty).toBe(90);
    expect(r.shortageQty).toBe(110);
  });

  it('SPECIFIC_BATCH с несуществующей партией — ошибка, а не тихий ноль', () => {
    expect(() => resolvePrice(BATCHES, { qty: 10, source: 'SPECIFIC_BATCH', batchId: 'нет' }))
      .toThrow(BatchSelectionError);
  });

  it('WEIGHTED_AVG усредняет по остаткам', () => {
    const r = resolvePrice(BATCHES, { qty: 100, source: 'WEIGHTED_AVG' });
    const expected = (90 * 345 + 500 * 408 + 800 * 471) / 1390;
    expect(r.unitPrice).toBeCloseTo(expected, 1);
  });

  it('LAST_PURCHASE берёт цену самого свежего прихода независимо от остатка', () => {
    const drained = BATCHES.map((b) => (b.id === 'b-jul' ? { ...b, qtyRemaining: 0 } : b));
    expect(resolvePrice(drained, { qty: 10, source: 'LAST_PURCHASE' }).unitPrice).toBe(471);
  });

  it('MANUAL без цены — ошибка', () => {
    expect(() => resolvePrice(BATCHES, { qty: 10, source: 'MANUAL' }))
      .toThrow(/нужно указать цену/);
  });

  it('MANUAL с ценой считает по ней весь объём', () => {
    const r = resolvePrice(BATCHES, { qty: 10, source: 'MANUAL', explicitPrice: 500 });
    expect(r.totalCost).toBe(5000);
    expect(r.basis).toBe('explicit');
  });
});

describe('Карантин аномальных цен (09 §4.5)', () => {
  // Реальный случай: труба с приходами по 2 548 и по 430 000 —
  // цена за метр против цены за тонну в одной номенклатуре
  const WITH_ANOMALY: BatchLike[] = [
    { id: 'ok-1', receiptDate: '2026-03-01', unitPrice: 430000, qtyRemaining: 10 },
    { id: 'ok-2', receiptDate: '2026-05-01', unitPrice: 445000, qtyRemaining: 10 },
    { id: 'bad', receiptDate: '2026-06-01', unitPrice: 2548, qtyRemaining: 100, priceAnomaly: true },
  ];

  it('партия на карантине не участвует в автоподборе', () => {
    const r = resolvePrice(WITH_ANOMALY, { qty: 15, source: 'FIFO_STOCK' });
    expect(r.allocations.map((a) => a.batchId)).toEqual(['ok-1', 'ok-2']);
    expect(r.excludedAnomalyBatchIds).toEqual(['bad']);
  });

  it('подтверждение снабжения возвращает партию в расчёт', () => {
    // Объём больше здоровых остатков (10 + 10), чтобы очередь дошла до спорной партии
    const r = resolvePrice(WITH_ANOMALY, { qty: 25, source: 'FIFO_STOCK', allowAnomalies: true });
    expect(r.allocations.map((a) => a.batchId)).toEqual(['ok-1', 'ok-2', 'bad']);
    expect(r.isShortage).toBe(false);
  });

  it('без подтверждения тот же объём даёт дефицит, а не дешёвую подмену', () => {
    const r = resolvePrice(WITH_ANOMALY, { qty: 25, source: 'FIFO_STOCK' });
    expect(r.shortageQty).toBe(5);
  });

  it('выбрать карантинную партию вручную без подтверждения нельзя', () => {
    expect(() => resolvePrice(WITH_ANOMALY, { qty: 5, source: 'SPECIFIC_BATCH', batchId: 'bad' }))
      .toThrow(/карантине/);
  });

  it('дефицит считается по последней здоровой цене, а не по аномальной', () => {
    const r = resolvePrice(WITH_ANOMALY, { qty: 30, source: 'FIFO_STOCK' });
    expect(r.shortageUnitPrice).toBe(445000);
  });
});

describe('Детектор аномалий', () => {
  it('медиана считается и для чётного, и для нечётного числа значений', () => {
    expect(median([345, 408, 471])).toBe(408);
    expect(median([345, 471])).toBe(408);
    expect(median([])).toBe(0);
  });

  it('обычный рыночный разброс 25–37 % аномалией не считается', () => {
    expect(isPriceAnomaly(471, [345, 408])).toBe(false);
    expect(isPriceAnomaly(551, [440, 470, 500])).toBe(false);
  });

  it('перепутанные единицы измерения ловятся: 2 548 против 430 000', () => {
    expect(isPriceAnomaly(2548, [430000, 445000])).toBe(true);
    expect(anomalyFactor(2548, [430000, 445000])).toBe(171.7);
  });

  it('аномалия ловится в обе стороны', () => {
    expect(isPriceAnomaly(4300000, [430000, 445000])).toBe(true);
  });

  it('первая партия материала аномальной быть не может — сравнивать не с чем', () => {
    expect(anomalyFactor(1000, [])).toBeNull();
    expect(isPriceAnomaly(1000, [])).toBe(false);
  });

  it('порог настраивается', () => {
    expect(isPriceAnomaly(1000, [400])).toBe(false);
    expect(isPriceAnomaly(1000, [400], 2)).toBe(true);
  });

  it('последняя закупочная берётся по дате прихода, а не по порядку записей', () => {
    expect(lastPurchasePriceOf(BATCHES)).toEqual({ price: 471, batchId: 'b-jul' });
    expect(lastPurchasePriceOf([])).toEqual({ price: 0, batchId: null });
  });
});
