import {
  STAGE_STEPS, stepKey, stageShapeError, resolveTrackingMode, allocateActualHours,
} from '../src/common/production-stages';

describe('Этапы заказа: три вида работ цеха (26.08.2026)', () => {
  it('три вида работ в порядке прохождения заказа', () => {
    expect(STAGE_STEPS.map((s) => s.key)).toEqual([
      'PRODUCTION:CUTTING', 'PRODUCTION:ASSEMBLY', 'PRODUCTION:PAINTING',
    ]);
  });

  it('передел есть только у производства', () => {
    const withRouting = STAGE_STEPS.filter((s) => s.routingStage !== null);
    expect(withRouting).toHaveLength(3);
    expect(withRouting.every((s) => s.code === 'PRODUCTION')).toBe(true);
  });

  it('обшивка вошла в сборку, как в «Спецификациях 2022» — отдельного шага нет', () => {
    expect(STAGE_STEPS.map((s) => s.key)).not.toContain('PRODUCTION:CLADDING');
    expect(STAGE_STEPS.find((s) => s.routingStage === 'ASSEMBLY')?.label)
      .toBe('Сборка / сварка / обшивка');
  });

  it('продажные стадии из этапов производства убраны', () => {
    const keys = STAGE_STEPS.map((s) => s.key).join(' ');
    expect(keys).not.toMatch(/OS_WITH_CUSTOMER|GENERAL_VIEW/);
  });

  it('ключ шага собирается из вехи и передела', () => {
    expect(stepKey('DESIGN', null)).toBe('DESIGN');
    expect(stepKey('PRODUCTION', 'CUTTING')).toBe('PRODUCTION:CUTTING');
  });
});

describe('Проверка формы этапа', () => {
  it('старые вехи «Чертежи»/«Закуп» отклоняются — это не работа цеха', () => {
    expect(stageShapeError('DESIGN', null)).toMatch(/Неизвестный этап/);
    expect(stageShapeError('SUPPLY', undefined)).toMatch(/Неизвестный этап/);
  });

  it('производство с переделом — валидно', () => {
    expect(stageShapeError('PRODUCTION', 'ASSEMBLY')).toBeNull();
  });

  it('производство без передела отклоняется', () => {
    expect(stageShapeError('PRODUCTION', null)).toMatch(/Нужен вид работ/);
  });

  it('«Снабжение / Резка» отклоняется — SUPPLY больше не существует', () => {
    expect(stageShapeError('SUPPLY', 'CUTTING')).toMatch(/Неизвестный этап/);
  });

  it('старые коды больше не принимаются', () => {
    expect(stageShapeError('DRAWINGS', null)).toMatch(/Неизвестный этап/);
    expect(stageShapeError('CLADDING', null)).toMatch(/Неизвестный этап/);
  });
});

describe('Режим отметки по числу позиций (09 §2.2)', () => {
  it('до порога включительно — отметка заказа целиком', () => {
    expect(resolveTrackingMode(1, 5)).toBe('ORDER');
    expect(resolveTrackingMode(5, 5)).toBe('ORDER');
  });

  it('выше порога — построчно: «резка по заказу» на 20 позициях ничего не значит', () => {
    expect(resolveTrackingMode(6, 5)).toBe('LINE');
    expect(resolveTrackingMode(30, 5)).toBe('LINE');
  });

  it('заказ без позиций остаётся простым', () => {
    expect(resolveTrackingMode(0, 5)).toBe('ORDER');
  });
});

describe('Раскладка фактических часов по позициям (09 §2.3)', () => {
  // Ферма даёт 80 % трудоёмкости сборки, балка — 20 %
  const LINES = [
    { orderLineId: 'ферма', normManHours: 4.8 },
    { orderLineId: 'балка', normManHours: 1.2 },
  ];

  it('часы делятся пропорционально нормативной трудоёмкости', () => {
    const a = allocateActualHours(120, LINES);
    expect(a).toEqual([
      { orderLineId: 'ферма', sharePct: 80, hours: 96 },
      { orderLineId: 'балка', sharePct: 20, hours: 24 },
    ]);
  });

  it('сумма раскладки равна введённому факту — иначе план/факт не сойдётся', () => {
    const a = allocateActualHours(100, [
      { orderLineId: 'a', normManHours: 1 },
      { orderLineId: 'b', normManHours: 1 },
      { orderLineId: 'c', normManHours: 1 },
    ]);
    expect(a.reduce((s, x) => s + x.hours, 0)).toBe(100);
  });

  it('без норм часы делятся поровну, а не теряются и не падают на первую позицию', () => {
    const a = allocateActualHours(90, [
      { orderLineId: 'a', normManHours: 0 },
      { orderLineId: 'b', normManHours: 0 },
    ]);
    expect(a.map((x) => x.hours)).toEqual([45, 45]);
  });

  it('позиция без нормы при наличии норм у других получает ноль часов', () => {
    const a = allocateActualHours(50, [
      { orderLineId: 'нормирована', normManHours: 5 },
      { orderLineId: 'без нормы', normManHours: 0 },
    ]);
    expect(a[0].hours).toBe(50);
    expect(a[1].hours).toBe(0);
  });

  it('отрицательная норма трактуется как ноль, а не выворачивает раскладку', () => {
    const a = allocateActualHours(10, [
      { orderLineId: 'a', normManHours: -5 },
      { orderLineId: 'b', normManHours: 5 },
    ]);
    expect(a[0].hours).toBe(0);
    expect(a[1].hours).toBe(10);
  });

  it('пустой заказ — пустая раскладка, без деления на ноль', () => {
    expect(allocateActualHours(100, [])).toEqual([]);
  });
});
