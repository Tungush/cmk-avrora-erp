import {
  calculateArticleCosting,
  explainCosting,
  CostingRates,
  CostingConfigError,
} from '../src/services/costing.service';

/** Новые системные ставки: маржинальность 35 % от цены (09_COSTING_AND_STAGES.md §3.2) */
const RATES_MARGIN: CostingRates = {
  hourlyRate: 2040,
  logisticsPct: 0.03,
  utilitiesPct: 0.01,
  marginPct: 0.35,
  marginMode: 'MARGIN',
};

/** Прежнее поведение исходника: 35 % как наценка на себестоимость */
const RATES_MARKUP: CostingRates = { ...RATES_MARGIN, marginMode: 'MARKUP' };

/** Себестоимость ровно 1 000 000 ₸ — материалы без труда и без процентов */
const MILLION: CostingRates = {
  hourlyRate: 0, logisticsPct: 0, utilitiesPct: 0, marginPct: 0.35, marginMode: 'MARGIN',
};

describe('Маржа: 35 % от цены против 35 % наценки (09 §3.2)', () => {
  it('MARGIN: цена = себестоимость / (1 − 35 %)', () => {
    const r = calculateArticleCosting(1_000_000, [], MILLION);
    expect(r.totalCost).toBe(1_000_000);
    expect(r.price).toBe(1_538_461.54);
    expect(r.margin).toBe(538_461.54);
  });

  it('MARGIN: доля маржи в цене — ровно заданные 35 %', () => {
    const r = calculateArticleCosting(1_000_000, [], MILLION);
    expect(r.marginOfPricePct).toBe(35);
  });

  it('MARGIN: та же маржа в пересчёте на наценку — 53,85 %', () => {
    const r = calculateArticleCosting(1_000_000, [], MILLION);
    expect(r.markupPct).toBe(53.85);
  });

  it('MARKUP: цена = себестоимость × (1 + 35 %) — разница 188 тысяч на миллион', () => {
    const r = calculateArticleCosting(1_000_000, [], { ...MILLION, marginMode: 'MARKUP' });
    expect(r.price).toBe(1_350_000);
    expect(r.margin).toBe(350_000);
    expect(r.marginOfPricePct).toBe(25.93);
  });

  it('оба режима на одной себестоимости расходятся именно на 188 461,54 ₸', () => {
    const margin = calculateArticleCosting(1_000_000, [], MILLION);
    const markup = calculateArticleCosting(1_000_000, [], { ...MILLION, marginMode: 'MARKUP' });
    expect(Math.round((margin.price - markup.price) * 100) / 100).toBe(188_461.54);
  });

  it('маржинальность 100 % и выше — ошибка конфигурации, а не деление на ноль', () => {
    expect(() => calculateArticleCosting(1000, [], { ...MILLION, marginPct: 1 }))
      .toThrow(CostingConfigError);
    expect(() => calculateArticleCosting(1000, [], { ...MILLION, marginPct: 1.2 }))
      .toThrow(/меньше 100 %/);
  });

  it('в режиме MARKUP процент 100 % и выше допустим — деления нет', () => {
    const r = calculateArticleCosting(1000, [], { ...MILLION, marginMode: 'MARKUP', marginPct: 1 });
    expect(r.price).toBe(2000);
  });

  it('нулевая себестоимость не даёт NaN ни в одном режиме', () => {
    for (const mode of ['MARGIN', 'MARKUP'] as const) {
      const r = calculateArticleCosting(0, [], { ...MILLION, marginMode: mode });
      expect(r.price).toBe(0);
      expect(r.marginOfPricePct).toBe(0);
      expect(r.markupPct).toBe(0);
    }
  });

  it('разбор формулы показывает обе трактовки процента рядом', () => {
    const e = explainCosting(calculateArticleCosting(1_000_000, [], MILLION), null, MILLION);
    expect(e.marginSummary.label).toBe('маржа 35 % от цены = наценка 53.85 %');
    expect(e.marginSummary.mode).toBe('MARGIN');
  });
});

describe('Логистика: три режима вместо константы 3 % (09 §3.2)', () => {
  it('PERCENT_OF_MATERIAL — прежнее поведение по умолчанию', () => {
    const r = calculateArticleCosting(1000, [], RATES_MARGIN);
    expect(r.logisticsCost).toBe(30);
  });

  it('FIXED_AMOUNT — сумма не зависит от стоимости материалов', () => {
    const rates: CostingRates = { ...RATES_MARGIN, logisticsMode: 'FIXED_AMOUNT', logisticsFixed: 120_000 };
    expect(calculateArticleCosting(1000, [], rates).logisticsCost).toBe(120_000);
    expect(calculateArticleCosting(5_000_000, [], rates).logisticsCost).toBe(120_000);
  });

  it('PER_KG — тариф на вес изделия', () => {
    const rates: CostingRates = { ...RATES_MARGIN, logisticsMode: 'PER_KG', logisticsPerKg: 45 };
    expect(calculateArticleCosting(1000, [], rates, { weightKg: 320 }).logisticsCost).toBe(14_400);
  });

  it('PER_KG без веса — ошибка, а не молчаливый ноль в цене', () => {
    const rates: CostingRates = { ...RATES_MARGIN, logisticsMode: 'PER_KG', logisticsPerKg: 45 };
    expect(() => calculateArticleCosting(1000, [], rates)).toThrow(CostingConfigError);
    expect(() => calculateArticleCosting(1000, [], rates, { weightKg: 0 })).toThrow(/веса изделия/);
  });

  it('подпись в разборе формулы соответствует выбранному режиму', () => {
    const fixed: CostingRates = { ...RATES_MARGIN, logisticsMode: 'FIXED_AMOUNT', logisticsFixed: 120_000 };
    const e = explainCosting(calculateArticleCosting(1000, [], fixed), null, fixed);
    expect(e.lines.find((l) => l.label === 'Логистика')?.formula).toBe('фиксированная сумма на заказ');
  });

  it('без переданных ставок процент выводится из самих сумм — подпись не врёт', () => {
    const r = calculateArticleCosting(1000, [], { ...RATES_MARGIN, logisticsPct: 0.05 });
    const e = explainCosting(r, null);
    expect(e.lines.find((l) => l.label === 'Логистика')?.formula).toBe('материалы × 5 %');
  });
});

describe('Совместимость: старые расчёты не меняются', () => {
  it('исходные 10 % наценки дают ту же цену, что и в «Спецификациях 2022»', () => {
    const legacy: CostingRates = { ...RATES_MARKUP, marginPct: 0.1 };
    const r = calculateArticleCosting(1000, [], legacy);
    expect(r.totalCost).toBe(1040);
    expect(r.margin).toBe(104);
    expect(r.price).toBe(1144);
  });
});
