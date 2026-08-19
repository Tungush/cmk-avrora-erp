import {
  calculateArticleCosting,
  explainCosting,
  actualDeviationPct,
  costingImpact,
  CostingRates,
} from '../src/services/costing.service';

/** Ставки исходника: «ЗП сотр.»!N9 = 2040, строка 1 «Спецификации 2022» */
const RATES: CostingRates = {
  hourlyRate: 2040,
  logisticsPct: 0.03,
  utilitiesPct: 0.01,
  marginPct: 0.1,
};

describe('Калькуляция «Спецификации 2022» (07_ARCHITECTURE_AND_UX.md §3)', () => {
  // Пример k-001 (U-болт ф76мм) из исходного листа, строка 5:
  // Резка: Y=2, Z=0.07 → AA=(Z*Y)*X = 0.14×2040 = 285.6
  // Сборка: AB=1, AC=0.15 → AD = 0.15×2040 = 306
  // Покраска: AE=1, AF=0.04 → AG = 0.04×2040 = 81.6
  const K001_NORMS = [
    { stage: 'CUTTING' as const, workers: 2, hoursPerUnit: 0.07 },
    { stage: 'ASSEMBLY' as const, workers: 1, hoursPerUnit: 0.15 },
    { stage: 'PAINTING' as const, workers: 1, hoursPerUnit: 0.04 },
  ];

  it('стоимость передела = чел × часы × ставка (формулы AA/AD/AG)', () => {
    const r = calculateArticleCosting(0, K001_NORMS, RATES);
    expect(r.stages[0].stageCost).toBe(285.6);
    expect(r.stages[1].stageCost).toBe(306);
    expect(r.stages[2].stageCost).toBe(81.6);
  });

  it('общий чел/час = Σ(чел × часы) — формула AH', () => {
    const r = calculateArticleCosting(0, K001_NORMS, RATES);
    expect(r.totalManHours).toBe(0.33);
  });

  it('себестоимость труда = Σ стоимостей переделов — формула AI', () => {
    const r = calculateArticleCosting(0, K001_NORMS, RATES);
    expect(r.laborCost).toBe(673.2);
  });

  it('логистика 3% и энергия 1% считаются от материалов — формулы AJ/AK', () => {
    const r = calculateArticleCosting(1000, K001_NORMS, RATES);
    expect(r.logisticsCost).toBe(30);
    expect(r.utilitiesCost).toBe(10);
  });

  it('себестоимость = материалы + труд + логистика + энергия — формула AM', () => {
    const r = calculateArticleCosting(1000, K001_NORMS, RATES);
    expect(r.totalCost).toBe(1000 + 673.2 + 30 + 10); // 1713.2
  });

  it('маржа 10% и цена — формулы AN/AP', () => {
    const r = calculateArticleCosting(1000, K001_NORMS, RATES);
    expect(r.margin).toBe(171.32);
    expect(r.price).toBe(1884.52);
  });

  it('ставка участка перекрывает общую ставку', () => {
    const r = calculateArticleCosting(
      0,
      [{ stage: 'CUTTING', workers: 2, hoursPerUnit: 0.07, hourlyRate: 1950 }],
      RATES,
    );
    expect(r.stages[0].hourlyRate).toBe(1950);
    expect(r.stages[0].stageCost).toBe(273);
  });

  it('изделие без норм: труд 0, цена = материалы + накладные + маржа', () => {
    const r = calculateArticleCosting(500, [], RATES);
    expect(r.laborCost).toBe(0);
    expect(r.totalCost).toBe(520); // 500 + 15 + 5
    expect(r.price).toBe(572);
  });

  describe('explainCosting — разбор формулы для UI', () => {
    it('строки разбора с источниками и формулами', () => {
      const r = calculateArticleCosting(243, K001_NORMS, RATES);
      const e = explainCosting(r, 715);
      const labels = e.lines.map((l) => l.label);
      expect(labels).toContain('Материалы');
      expect(labels).toContain('Резка');
      expect(labels).toContain('Себестоимость');
      expect(labels).toContain('Расчётная цена');
      const cutting = e.lines.find((l) => l.label === 'Резка')!;
      expect(cutting.formula).toBe('2 чел × 0.07 ч × 2040 ₸/час');
    });

    it('сверка с утверждённой ценой: отклонение и флаг «ниже себестоимости»', () => {
      const r = calculateArticleCosting(243, K001_NORMS, RATES);
      // totalCost = 243 + 673.2 + 7.29 + 2.43 = 925.92; price ≈ 1018.51
      const e = explainCosting(r, 715);
      expect(e.priceCheck).not.toBeNull();
      expect(e.priceCheck!.belowCost).toBe(true); // 715 < 925.92 — прайс ниже себестоимости
      expect(e.priceCheck!.deviationPct).toBeLessThan(0);
    });

    it('без утверждённой цены priceCheck = null', () => {
      const r = calculateArticleCosting(243, K001_NORMS, RATES);
      expect(explainCosting(r, null).priceCheck).toBeNull();
      expect(explainCosting(r, 0).priceCheck).toBeNull();
    });
  });

  describe('costingImpact — предпросмотр влияния (§2.3 ④)', () => {
    it('правка часов сборки 0.15 → 0.22 даёт дельты по труду, себестоимости и цене', () => {
      const current = calculateArticleCosting(243, K001_NORMS, RATES);
      const proposed = calculateArticleCosting(
        243,
        [
          K001_NORMS[0],
          { stage: 'ASSEMBLY', workers: 1, hoursPerUnit: 0.22 },
          K001_NORMS[2],
        ],
        RATES,
      );
      const impact = costingImpact(current, proposed);

      const manHours = impact.find((l) => l.label === 'Трудоёмкость')!;
      expect(manHours.before).toBe(0.33);
      expect(manHours.after).toBe(0.4);
      expect(manHours.delta).toBeCloseTo(0.07, 2);

      const labor = impact.find((l) => l.label === 'Себестоимость труда')!;
      // 0.07 чел/час × 2040 = +142.8
      expect(labor.delta).toBeCloseTo(142.8, 1);

      const cost = impact.find((l) => l.label === 'Себестоимость')!;
      expect(cost.delta).toBeCloseTo(142.8, 1);
      expect(cost.deltaPct).toBeGreaterThan(0);

      const price = impact.find((l) => l.label === 'Расчётная цена')!;
      // дельта цены = дельта себестоимости × 1.1 (маржа 10 %)
      expect(price.delta).toBeCloseTo(157.08, 1);
    });

    it('без изменений — все дельты нулевые', () => {
      const r = calculateArticleCosting(243, K001_NORMS, RATES);
      for (const l of costingImpact(r, r)) {
        expect(l.delta).toBe(0);
      }
    });

    it('нулевое «до» → deltaPct = null (не делим на ноль)', () => {
      const empty = calculateArticleCosting(0, [], RATES);
      const withNorms = calculateArticleCosting(0, K001_NORMS, RATES);
      const labor = costingImpact(empty, withNorms).find((l) => l.label === 'Себестоимость труда')!;
      expect(labor.deltaPct).toBeNull();
      expect(labor.delta).toBe(673.2);
    });
  });

  describe('actualDeviationPct — сравнение факта с нормой', () => {
    it('факт выше нормы → положительное отклонение', () => {
      // норма 0.14 чел/час; факт 2 × 0.082 = 0.164 → +17.14%
      expect(actualDeviationPct(0.14, 2, 0.082)).toBeCloseTo(17.14, 1);
    });

    it('факта нет → null', () => {
      expect(actualDeviationPct(0.14, null, null)).toBeNull();
      expect(actualDeviationPct(0.14, 2, null)).toBeNull();
    });

    it('нулевая норма → null (не делим на ноль)', () => {
      expect(actualDeviationPct(0, 2, 0.1)).toBeNull();
    });
  });
});
