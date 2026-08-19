import {
  compareMaterials, compareLabor, compareCostings, reconcile, CostingSnapshot,
} from '../src/common/costing-compare';

const snapshot = (over: Partial<CostingSnapshot> = {}): CostingSnapshot => ({
  version: 1,
  calculatedAt: '2026-07-15',
  qty: 4,
  materialCost: 0, laborCost: 0, logisticsCost: 0, utilitiesCost: 0,
  totalCost: 0, margin: 0, price: 0,
  logisticsPct: 0.03, logisticsMode: 'PERCENT_OF_MATERIAL',
  utilitiesPct: 0.01, marginPct: 0.35, marginMode: 'MARGIN',
  materials: [], labor: [],
  ...over,
});

describe('Материалы: цена, объём и состав разделены (09 §6)', () => {
  it('рост цены при том же расходе — целиком эффект цены', () => {
    const r = compareMaterials(
      [{ materialId: 'лист', name: 'Лист г/к 20мм', qtyTotal: 1000, unitPrice: 345, lineCost: 345000 }],
      [{ materialId: 'лист', name: 'Лист г/к 20мм', qtyTotal: 1000, unitPrice: 471, lineCost: 471000 }],
    );
    expect(r.priceEffect).toBe(126000);
    expect(r.qtyEffect).toBe(0);
    expect(r.delta).toBe(126000);
  });

  it('изменение расхода при той же цене — целиком эффект объёма', () => {
    const r = compareMaterials(
      [{ materialId: 'лист', name: 'Лист', qtyTotal: 1000, unitPrice: 400, lineCost: 400000 }],
      [{ materialId: 'лист', name: 'Лист', qtyTotal: 1200, unitPrice: 400, lineCost: 480000 }],
    );
    expect(r.qtyEffect).toBe(80000);
    expect(r.priceEffect).toBe(0);
  });

  it('разложение сходится с фактической разницей и при изменении обоих', () => {
    const base = [{ materialId: 'лист', name: 'Лист', qtyTotal: 1000, unitPrice: 345, lineCost: 345000 }];
    const target = [{ materialId: 'лист', name: 'Лист', qtyTotal: 1200, unitPrice: 471, lineCost: 565200 }];
    const r = compareMaterials(base, target);
    expect(r.priceEffect + r.qtyEffect).toBe(565200 - 345000);
  });

  it('новая позиция уходит в изменение состава, а не в цену', () => {
    const r = compareMaterials(
      [],
      [{ materialId: 'петля', name: 'Петля', qtyTotal: 4, unitPrice: 10000, lineCost: 40000 }],
    );
    expect(r.mixEffect).toBe(40000);
    expect(r.priceEffect).toBe(0);
    expect(r.details[0].note).toBe('добавлено в состав');
  });

  it('убранная позиция уменьшает состав', () => {
    const r = compareMaterials(
      [{ materialId: 'петля', name: 'Петля', qtyTotal: 4, unitPrice: 10000, lineCost: 40000 }],
      [],
    );
    expect(r.mixEffect).toBe(-40000);
    expect(r.details[0].note).toBe('убрано из состава');
  });

  it('смена партии попадает в пояснение — это и был исходный вопрос', () => {
    const r = compareMaterials(
      [{ materialId: 'лист', name: 'Лист', qtyTotal: 100, unitPrice: 345, lineCost: 34500, batchId: 'b-apr' }],
      [{ materialId: 'лист', name: 'Лист', qtyTotal: 100, unitPrice: 471, lineCost: 47100, batchId: 'b-jul' }],
    );
    expect(r.details[0].note).toContain('другая партия');
    expect(r.details[0].note).toContain('345 → 471');
  });

  it('позиции без id сопоставляются по имени без учёта регистра', () => {
    const r = compareMaterials(
      [{ materialId: null, name: 'Уголок 50х50', qtyTotal: 10, unitPrice: 100, lineCost: 1000 }],
      [{ materialId: null, name: 'уголок 50х50 ', qtyTotal: 10, unitPrice: 120, lineCost: 1200 }],
    );
    expect(r.mixEffect).toBe(0);
    expect(r.priceEffect).toBe(200);
  });
});

describe('Труд: ставка, норма и смена исполнителя', () => {
  const staff = (over = {}) => ({
    stage: 'ASSEMBLY', laborKind: 'STAFF', rateType: 'PER_HOUR',
    rate: 2040, manHours: 10, lineCost: 20400, ...over,
  });

  it('рост ставки при тех же часах — эффект ставки', () => {
    const r = compareLabor([staff()], [staff({ rate: 2200, lineCost: 22000 })]);
    expect(r.rateEffect).toBe(1600);
    expect(r.normEffect).toBe(0);
  });

  it('рост часов при той же ставке — эффект нормы', () => {
    const r = compareLabor([staff()], [staff({ manHours: 12, lineCost: 24480 })]);
    expect(r.normEffect).toBe(4080);
    expect(r.rateEffect).toBe(0);
  });

  it('переход со штата на подряд — отдельная причина, а не «ставка выросла»', () => {
    const r = compareLabor(
      [staff()],
      [staff({ laborKind: 'CONTRACTOR', rateType: 'PER_UNIT', rate: 18000, manHours: 0, lineCost: 72000 })],
    );
    expect(r.executorEffect).toBe(51600);
    expect(r.rateEffect).toBe(0);
    expect(r.details[0].note).toContain('STAFF → CONTRACTOR');
  });

  it('сдельная ставка без часов: вся разница относится на ставку', () => {
    const piece = (rate: number, cost: number) => ({
      stage: 'ASSEMBLY', laborKind: 'CONTRACTOR', rateType: 'PER_UNIT',
      rate, manHours: 0, lineCost: cost,
    });
    const r = compareLabor([piece(18000, 72000)], [piece(20000, 80000)]);
    expect(r.rateEffect).toBe(8000);
  });

  it('добавленный передел уходит в изменение состава работ', () => {
    const r = compareLabor([], [staff({ stage: 'PAINTING' })]);
    expect(r.mixEffect).toBe(20400);
  });
});

describe('Сходимость разбора', () => {
  it('сумма факторов равна разнице цены — до копейки', () => {
    const base = snapshot({
      version: 1,
      materials: [{ materialId: 'лист', name: 'Лист', qtyTotal: 1000, unitPrice: 345, lineCost: 345000 }],
      labor: [{ stage: 'ASSEMBLY', laborKind: 'STAFF', rateType: 'PER_HOUR', rate: 2040, manHours: 10, lineCost: 20400 }],
      materialCost: 345000, laborCost: 20400, logisticsCost: 10350, utilitiesCost: 3450,
      totalCost: 379200, margin: 204184.62, price: 583384.62,
    });
    const target = snapshot({
      version: 2,
      calculatedAt: '2026-08-19',
      materials: [
        { materialId: 'лист', name: 'Лист', qtyTotal: 1000, unitPrice: 471, lineCost: 471000 },
        { materialId: 'петля', name: 'Петля', qtyTotal: 4, unitPrice: 10000, lineCost: 40000 },
      ],
      labor: [{ stage: 'ASSEMBLY', laborKind: 'STAFF', rateType: 'PER_HOUR', rate: 2200, manHours: 12, lineCost: 26400 }],
      materialCost: 511000, laborCost: 26400, logisticsCost: 15330, utilitiesCost: 5110,
      totalCost: 557840, margin: 300375.38, price: 858215.38,
    });

    const cmp = compareCostings(base, target);
    expect(cmp.price.delta).toBe(274830.76);
    expect(reconcile(cmp)).toBe(0);
  });

  it('материалы разложены на цену и состав по отдельности', () => {
    const base = snapshot({
      materials: [{ materialId: 'лист', name: 'Лист', qtyTotal: 1000, unitPrice: 345, lineCost: 345000 }],
    });
    const target = snapshot({
      version: 2,
      materials: [
        { materialId: 'лист', name: 'Лист', qtyTotal: 1000, unitPrice: 471, lineCost: 471000 },
        { materialId: 'петля', name: 'Петля', qtyTotal: 4, unitPrice: 10000, lineCost: 40000 },
      ],
    });
    const cmp = compareCostings(base, target);
    expect(cmp.factors.materials.priceEffect).toBe(126000);
    expect(cmp.factors.materials.mixEffect).toBe(40000);
  });

  it('процент не менялся — так и написано, эффект базы', () => {
    const cmp = compareCostings(snapshot(), snapshot({ version: 2 }));
    expect(cmp.factors.margin.note).toBe('процент не менялся, эффект базы');
    expect(cmp.factors.logistics.note).toBe('процент не менялся, эффект базы');
  });

  it('изменение процента логистики попадает в пояснение', () => {
    const cmp = compareCostings(snapshot(), snapshot({ version: 2, logisticsPct: 0.035 }));
    expect(cmp.factors.logistics.note).toBe('3 % → 3.5 %');
  });

  it('смена режима маржи видна отдельно от процента', () => {
    const cmp = compareCostings(snapshot(), snapshot({ version: 2, marginMode: 'MARKUP' }));
    expect(cmp.factors.margin.note).toBe('режим MARGIN → MARKUP');
  });
});
