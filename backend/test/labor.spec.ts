import {
  calcAssignmentCost, validateShares, summarizeLabor, defaultStaffAssignments,
  rateTypeAvailable, LaborAssignment, LaborConfigError, DEFAULT_RATE_TYPE,
} from '../src/common/labor';

const STAFF_ASSEMBLY: LaborAssignment = {
  stage: 'ASSEMBLY', laborKind: 'STAFF', share: 1, rateType: 'PER_HOUR', rate: 2040,
  countInShopHours: true, workers: 1, hoursPerUnit: 0.15,
};

describe('Пять типов ставок подряда (09 §5.2)', () => {
  const ctx = { qty: 4, weightKg: 320 };

  it('PER_HOUR: чел × часы × количество × доля × ставка', () => {
    const r = calcAssignmentCost({ ...STAFF_ASSEMBLY }, ctx);
    expect(r.manHours).toBe(0.6);
    expect(r.cost).toBe(1224);
  });

  it('PER_UNIT: количество × доля × ставка', () => {
    const r = calcAssignmentCost({
      ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', rateType: 'PER_UNIT', rate: 18000,
      countInShopHours: false,
    }, ctx);
    expect(r.cost).toBe(72000);
  });

  it('PER_KG использует вес изделия', () => {
    const r = calcAssignmentCost({
      ...STAFF_ASSEMBLY, rateType: 'PER_KG', rate: 150, countInShopHours: false,
    }, ctx);
    expect(r.cost).toBe(4 * 320 * 150);
  });

  it('PER_TON пересчитывает вес в тонны сам', () => {
    const r = calcAssignmentCost({
      ...STAFF_ASSEMBLY, rateType: 'PER_TON', rate: 150000, countInShopHours: false,
    }, ctx);
    expect(r.cost).toBe(round2((4 * 320 / 1000) * 150000));
    function round2(n: number) { return Math.round(n * 100) / 100; }
  });

  it('FIXED — сумма за весь объём, количество не умножает', () => {
    const r = calcAssignmentCost({
      ...STAFF_ASSEMBLY, rateType: 'FIXED', rate: 500000, countInShopHours: false,
    }, ctx);
    expect(r.cost).toBe(500000);
  });

  it('дефолт — за штуку: вес заполнен у 3,2 % артикулов', () => {
    expect(DEFAULT_RATE_TYPE).toBe('PER_UNIT');
  });
});

describe('Защита от молчаливых нулей (09 §5.2—5.3)', () => {
  it('весовая ставка без веса — ошибка, а не ноль в себестоимости', () => {
    expect(() => calcAssignmentCost(
      { ...STAFF_ASSEMBLY, rateType: 'PER_TON', rate: 150000, countInShopHours: false },
      { qty: 4, weightKg: 0 },
    )).toThrow(LaborConfigError);
  });

  it('весовые ставки недоступны, пока вес не заполнен', () => {
    expect(rateTypeAvailable('PER_KG', 0)).toBe(false);
    expect(rateTypeAvailable('PER_KG', 320)).toBe(true);
    expect(rateTypeAvailable('PER_UNIT', 0)).toBe(true);
  });

  it('сдельный подряд в нашем цеху без оценки часов — ошибка', () => {
    expect(() => calcAssignmentCost(
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', rateType: 'PER_UNIT', rate: 18000, countInShopHours: true },
      { qty: 4 },
    )).toThrow(/оценка часов/);
  });

  it('с оценкой часов тот же подряд считается и занимает участок', () => {
    const r = calcAssignmentCost(
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', rateType: 'PER_UNIT', rate: 18000, countInShopHours: true, plannedHours: 36 },
      { qty: 4 },
    );
    expect(r.cost).toBe(72000);
    expect(r.manHours).toBe(36);
  });

  it('сдельный подряд на стороне оценки часов не требует', () => {
    expect(() => calcAssignmentCost(
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', rateType: 'FIXED', rate: 500000, countInShopHours: false },
      { qty: 4 },
    )).not.toThrow();
  });
});

// Измеренный факт подряда (решение 23.08.2026): actualQty выражен в единицах
// СВОЕЙ ставки, поэтому плановый объём qty × share им замещается целиком
describe('Факт подряда важнее плана', () => {
  const ctx = { qty: 4, weightKg: 320 };

  it('PER_HOUR: отработанные часы вытесняют норму', () => {
    const r = calcAssignmentCost(
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', actualQty: 112 },
      ctx,
    );
    expect(r.manHours).toBe(112);
    expect(r.cost).toBe(112 * 2040);
  });

  it('PER_TON: сданные тонны считаются напрямую, вес изделия не нужен', () => {
    const r = calcAssignmentCost({
      ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', rateType: 'PER_TON', rate: 45000,
      countInShopHours: false, actualQty: 3.2,
    }, { qty: 4 });
    expect(r.cost).toBe(144000);
  });

  it('замороженная при приёмке сумма важнее пересчёта по ставке', () => {
    const r = calcAssignmentCost(
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', actualQty: 112, actualAmount: 260000 },
      ctx,
    );
    expect(r.cost).toBe(260000);
    // Часы при этом остаются измеренными — они про мощность, а не про деньги
    expect(r.manHours).toBe(112);
  });

  it('без факта объём остаётся плановым', () => {
    const r = calcAssignmentCost({ ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR' }, ctx);
    expect(r.manHours).toBe(0.6);
  });
});

// Подряд, заведённый на заказ целиком, попадает в калькуляцию КАЖДОЙ позиции.
// Абсолютные величины (фикс и принятая сумма) без разнесения списывались бы
// полностью в каждую — заказ из двух позиций стоил бы вдвое дороже.
describe('Разнесение заказ-уровневого подряда по позициям', () => {
  const CONTRACTOR = {
    ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR' as const, countInShopHours: false,
  };

  it('фикс делится между позициями, а не списывается в каждую целиком', () => {
    const half = calcAssignmentCost(
      { ...CONTRACTOR, rateType: 'FIXED', rate: 500000, allocationFactor: 0.5 },
      { qty: 4 },
    );
    expect(half.cost).toBe(250000);
    // Сумма по двум позициям возвращает исходные 500 000, а не 1 000 000
    const other = calcAssignmentCost(
      { ...CONTRACTOR, rateType: 'FIXED', rate: 500000, allocationFactor: 0.5 },
      { qty: 6 },
    );
    expect(half.cost + other.cost).toBe(500000);
  });

  it('принятая сумма делится так же', () => {
    const r = calcAssignmentCost(
      { ...CONTRACTOR, actualQty: 112, actualAmount: 280000, allocationFactor: 0.25 },
      { qty: 4 },
    );
    expect(r.cost).toBe(70000);
  });

  it('измеренный объём тоже делится: 3,2 т на две позиции — не 6,4 т', () => {
    const r = calcAssignmentCost(
      { ...CONTRACTOR, rateType: 'PER_TON', rate: 90000, actualQty: 3.2, allocationFactor: 0.5 },
      { qty: 4 },
    );
    expect(r.cost).toBe(144000);
  });

  it('строка, заведённая на саму позицию, не делится', () => {
    const r = calcAssignmentCost(
      { ...CONTRACTOR, rateType: 'FIXED', rate: 500000 },
      { qty: 4 },
    );
    expect(r.cost).toBe(500000);
  });

  it('сдельная плановая ставка не делится — объём и так берётся из позиции', () => {
    const r = calcAssignmentCost(
      { ...CONTRACTOR, rateType: 'PER_UNIT', rate: 18000, allocationFactor: 0.5 },
      { qty: 4 },
    );
    // 4 шт × 18 000, а не половина: количество уже принадлежит этой позиции
    expect(r.cost).toBe(72000);
  });
});

describe('Доли на переделе', () => {
  it('одна строка на переделе — доля 1', () => {
    expect(validateShares([STAFF_ASSEMBLY])).toBeNull();
  });

  it('штат 50 % + подряд 50 % — валидно', () => {
    expect(validateShares([
      { ...STAFF_ASSEMBLY, share: 0.5 },
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', share: 0.5 },
    ])).toBeNull();
  });

  // Недобор перестал быть ошибкой (решение 23.08.2026): штат не хранится
  // строкой, он остаток от нормы. Одинокая доля 0.5 — это либо подряд на
  // половину передела (вторую делает штат по норме), либо передел без нормы
  it('недобор долей допустим: остаток забирает штат по норме', () => {
    expect(validateShares([{ ...STAFF_ASSEMBLY, share: 0.5 }])).toBeNull();
  });

  it('одинокий подряд без нормы считается, а не падает', () => {
    expect(validateShares([
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', share: 0.6 },
    ])).toBeNull();
  });

  it('перебор долей ловится: объём посчитан дважды', () => {
    expect(validateShares([
      { ...STAFF_ASSEMBLY, share: 0.7 },
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', share: 0.7 },
    ])).toMatch(/140 %/);
  });

  it('разные переделы считаются независимо', () => {
    expect(validateShares([
      { ...STAFF_ASSEMBLY, stage: 'CUTTING', share: 1 },
      { ...STAFF_ASSEMBLY, stage: 'ASSEMBLY', share: 0.5 },
      { ...STAFF_ASSEMBLY, stage: 'ASSEMBLY', laborKind: 'CONTRACTOR', share: 0.5 },
    ])).toBeNull();
  });
});

describe('Смешанный передел: штат и подряд вместе (09 §5.4)', () => {
  // Ферма Ф-200 ×4: половину сборки делает штат, половину — ТОО «Мехмонтаж»
  const MIXED: LaborAssignment[] = [
    { ...STAFF_ASSEMBLY, share: 0.5 },
    {
      stage: 'ASSEMBLY', laborKind: 'CONTRACTOR', share: 0.5, rateType: 'PER_UNIT',
      rate: 18000, countInShopHours: true, plannedHours: 36, contractorId: 'мехмонтаж',
    },
  ];

  it('стоимость передела — сумма обеих строк', () => {
    const s = summarizeLabor(MIXED, { qty: 4 });
    expect(s.byStage).toEqual([{ stage: 'ASSEMBLY', cost: 36612, manHours: 36.3 }]);
  });

  it('штат и подряд разделены в сводке', () => {
    const s = summarizeLabor(MIXED, { qty: 4 });
    expect(s.staffCost).toBe(612);
    expect(s.contractorCost).toBe(36000);
    expect(s.totalCost).toBe(36612);
  });

  it('подряд в нашем цеху попадает в трудозатраты цеха', () => {
    const s = summarizeLabor(MIXED, { qty: 4 });
    expect(s.shopManHours).toBe(36.3);
    expect(s.offsiteContractorCost).toBe(0);
  });

  it('тот же подряд на стороне мощность цеха не занимает', () => {
    const offsite = MIXED.map((a) => (
      a.laborKind === 'CONTRACTOR' ? { ...a, countInShopHours: false } : a
    ));
    const s = summarizeLabor(offsite, { qty: 4 });
    expect(s.shopManHours).toBe(0.3);
    expect(s.offsiteContractorCost).toBe(36000);
    expect(s.totalCost).toBe(36612);
  });

  it('двойной счёт не даёт посчитать заказ вовсе', () => {
    expect(() => summarizeLabor([
      { ...STAFF_ASSEMBLY, share: 0.8 },
      { ...STAFF_ASSEMBLY, laborKind: 'CONTRACTOR', share: 0.8 },
    ], { qty: 4 })).toThrow(LaborConfigError);
  });
});

describe('Строки исполнения по умолчанию', () => {
  it('без решения человека весь объём делает штат по нормам изделия', () => {
    const a = defaultStaffAssignments([
      { stage: 'CUTTING', workers: 2, hoursPerUnit: 0.07, hourlyRate: 2040 },
      { stage: 'ASSEMBLY', workers: 1, hoursPerUnit: 0.15, hourlyRate: 2200 },
    ]);
    expect(a).toHaveLength(2);
    expect(a.every((x) => x.laborKind === 'STAFF' && x.share === 1)).toBe(true);
    expect(validateShares(a)).toBeNull();
  });

  it('ставка берётся из участка, а не общая', () => {
    const a = defaultStaffAssignments([
      { stage: 'ASSEMBLY', workers: 1, hoursPerUnit: 0.15, hourlyRate: 2200 },
    ]);
    expect(summarizeLabor(a, { qty: 4 }).totalCost).toBe(1320);
  });
});
