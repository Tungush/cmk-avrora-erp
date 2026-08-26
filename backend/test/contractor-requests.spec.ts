import { Prisma } from '@prisma/client';
import {
  splitAmount, splitProportional, allocationSummary, RequestLike,
  RATE_UNITS, STAGE_LABELS,
} from '../src/common/contractor-requests';

// Деньги сравниваем в копейках: 0.1 + 0.2 !== 0.3, и тест на float-равенстве
// молча пропустил бы расхождение с актом на копейку — ровно то, что ищем
const cents = (n: number) => Math.round(n * 100);
const sumCents = (parts: number[]) => parts.reduce((s, p) => s + cents(p), 0);

describe('splitAmount: сумма долей копейка в копейку равна акту', () => {
  // Главный инвариант модуля. Бухгалтерия сверяет акт подрядчика с суммой
  // по заказам; расхождение в 1 ₸ — это расследование, а не округление
  it('1 000 000 ₸ на три равных объёма — не 999 999,99', () => {
    const parts = splitAmount(1000000, [10, 10, 10]);
    expect(sumCents(parts)).toBe(cents(1000000));
    expect(parts).toEqual([333333.33, 333333.33, 333333.34]);
  });

  it('100,01 ₸ на три — неделимая копейка не теряется', () => {
    const parts = splitAmount(100.01, [1, 1, 1]);
    expect(sumCents(parts)).toBe(cents(100.01));
  });

  it('0,03 ₸ на семь — доли меньше копейки не обнуляют сумму', () => {
    const parts = splitAmount(0.03, [1, 1, 1, 1, 1, 1, 1]);
    expect(sumCents(parts)).toBe(cents(0.03));
    // Шесть долей честно нулевые: копейка неделима, дробить её некуда
    expect(parts.filter((p) => p > 0)).toEqual([0.03]);
  });

  it('акт с дробными тоннами по семи заказам сходится', () => {
    const qtys = [1.234, 0.017, 12.5, 3.333, 0.001, 44.44, 7.7];
    const parts = splitAmount(4_567_890.13, qtys);
    expect(sumCents(parts)).toBe(cents(4_567_890.13));
  });

  // Детерминированный перебор вместо одного удачного примера: инвариант
  // обязан держаться на любых объёмах, а не на тех, что пришли в голову.
  // Генератор с фиксированным зерном — тест не может «мигать»
  it('держится на 500 случайных наборах (зерно фиксировано)', () => {
    let seed = 20260826;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 500; i += 1) {
      const n = 1 + Math.floor(rnd() * 6);
      // Каждый пятый объём — ноль: строка заведена, но работа туда не ушла
      const qtys = Array.from({ length: n }, () => (rnd() < 0.2 ? 0 : Math.round(rnd() * 100000) / 100));
      const total = Math.round(rnd() * 500_000_000) / 100;
      const parts = splitAmount(total, qtys);
      if (qtys.every((q) => q === 0)) continue;
      expect(sumCents(parts)).toBe(cents(total));
      qtys.forEach((q, k) => { if (q === 0) expect(parts[k]).toBe(0); });
    }
  });
});

describe('splitAmount: вырожденные объёмы', () => {
  // Заказ, куда не ушло ни килограмма, не может получить денег подрядчика:
  // иначе его себестоимость растёт от чужой работы
  it('нулевой объём получает ноль, а не долю', () => {
    const parts = splitAmount(900, [3, 0, 3]);
    expect(parts).toEqual([450, 0, 450]);
  });

  // Заявка, разнесённая строками с нулевым объёмом (объём ещё не проставили):
  // деления на ноль быть не должно, NaN бы разошёлся по всей калькуляции
  it('все объёмы нули — все доли нули, без NaN', () => {
    const parts = splitAmount(500000, [0, 0, 0]);
    expect(parts).toEqual([0, 0, 0]);
    expect(parts.every(Number.isFinite)).toBe(true);
  });

  it('единственный заказ забирает всю сумму', () => {
    expect(splitAmount(123.45, [7])).toEqual([123.45]);
  });

  it('пустой список строк — пустой результат', () => {
    expect(splitAmount(1000, [])).toEqual([]);
  });

  // Отрицательный объём — испорченные данные; трактуем как ноль, а не как
  // «вычесть деньги из заказа»
  it('отрицательный объём считается нулём', () => {
    const parts = splitAmount(100, [-5, 5]);
    expect(parts).toEqual([0, 100]);
    expect(sumCents(parts)).toBe(cents(100));
  });
});

describe('splitAmount: остаток достаётся последней НЕнулевой доле', () => {
  // Если остаток свалить просто в последний элемент, заказ с нулевым
  // объёмом получит копейки ниоткуда — и объяснить их в акте будет нечем
  it('последняя строка с нулевым объёмом остаётся с нулём', () => {
    const parts = splitAmount(100.01, [1, 1, 0]);
    expect(parts[2]).toBe(0);
    expect(sumCents(parts)).toBe(cents(100.01));
    // Остаток ушёл во вторую строку — последнюю из ненулевых
    expect(parts).toEqual([50.01, 50, 0]);
  });

  it('хвост из нескольких нулей не получает ничего', () => {
    const parts = splitAmount(1000000, [10, 10, 10, 0, 0]);
    expect(parts.slice(3)).toEqual([0, 0]);
    expect(parts[2]).toBe(333333.34);
    expect(sumCents(parts)).toBe(cents(1000000));
  });
});

describe('splitProportional: часы делятся пропорционально', () => {
  // Часы — про загрузку участка, а не про деньги: копеечное схождение здесь
  // не нужно и намеренно не делается (иначе функцией начнут делить суммы)
  it('три знака после запятой, ровно пропорция', () => {
    expect(splitProportional(100, [1, 1, 1])).toEqual([33.333, 33.333, 33.333]);
  });

  it('неравные объёмы дают неравные часы', () => {
    expect(splitProportional(36, [1, 3])).toEqual([9, 27]);
  });

  it('часы округляются до трёх знаков, а не до копеек', () => {
    expect(splitProportional(10, [3, 7])).toEqual([3, 7]);
    expect(splitProportional(1, [1, 2])).toEqual([0.333, 0.667]);
  });

  it('нулевой объём — ноль часов, деления на ноль нет', () => {
    expect(splitProportional(40, [0, 0])).toEqual([0, 0]);
    expect(splitProportional(40, [0, 4])).toEqual([0, 40]);
  });
});

// ————— allocationSummary —————

const NOW = new Date('2026-08-26T12:00:00Z');
const D = (iso: string) => new Date(iso);

const req = (o: Partial<RequestLike> = {}): RequestLike => ({
  id: 'r-1',
  number: 'ПОДР-001',
  routingStage: 'ASSEMBLY',
  rateType: 'PER_TON',
  status: 'ACCEPTED',
  plannedQty: 10,
  rate: 45000,
  estimatedAmount: null,
  actualQty: null,
  actualAmount: null,
  acceptedAt: null,
  bitrixDealId: null,
  bitrixSentAt: null,
  workLocation: 'CONTRACTOR_SITE',
  plannedHours: null,
  createdAt: D('2026-08-01T09:00:00Z'),
  contractor: null,
  works: [],
  ...o,
});

const work = (qty: number, amount: number, orderNumber = '1') => ({
  actualQty: qty, actualAmount: amount, order: { id: `o-${orderNumber}`, orderNumber },
});

describe('allocationSummary: needsAllocation — деньги, висящие в воздухе', () => {
  // Самая дорогая тишина в потоке: акт подписан и оплачивается, но подряд
  // не сидит ни в одном заказе. Себестоимость занижена, штат при этом
  // считается по норме на все 100 % — заказ выглядит прибыльнее, чем есть
  it('принята, но не разнесена — флаг поднят', () => {
    const s = allocationSummary(req({ actualQty: 10, actualAmount: 450000, acceptedAt: D('2026-08-25T10:00:00Z') }), 7, NOW);
    expect(s.needsAllocation).toBe(true);
    expect(s.unallocatedAmount).toBe(450000);
    expect(s.unallocatedQty).toBe(10);
  });

  // Пока акта нет, разносить нечего: заявка живёт в плане и флаг молчит
  it('не принята — флага нет, даже если ничего не разнесено', () => {
    const s = allocationSummary(req({ status: 'SENT', acceptedAt: null }), 7, NOW);
    expect(s.needsAllocation).toBe(false);
    expect(s.isStale).toBe(false);
    expect(s.daysSinceAccepted).toBeNull();
  });

  it('разнесено меньше принятого — флаг поднят', () => {
    const s = allocationSummary(req({
      actualQty: 10, actualAmount: 450000, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(4, 180000, '1')],
    }), 7, NOW);
    expect(s.needsAllocation).toBe(true);
    expect(s.allocatedQty).toBe(4);
    expect(s.unallocatedQty).toBe(6);
    expect(s.unallocatedAmount).toBe(270000);
  });

  it('разнесено полностью — флаг снят', () => {
    const s = allocationSummary(req({
      actualQty: 10, actualAmount: 450000, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(4, 180000, '1'), work(6, 270000, '2')],
    }), 7, NOW);
    expect(s.needsAllocation).toBe(false);
    expect(s.unallocatedQty).toBe(0);
    expect(s.unallocatedAmount).toBe(0);
    expect(s.ordersCount).toBe(2);
  });

  // Дробные тонны не должны поднимать флаг из-за 1e-15 в хвосте float
  it('дробный объём, сошедшийся с точностью float, флага не поднимает', () => {
    const s = allocationSummary(req({
      actualQty: 0.3, actualAmount: 13500, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(0.1, 4500, '1'), work(0.2, 9000, '2')],
    }), 7, NOW);
    expect(s.needsAllocation).toBe(false);
    expect(s.unallocatedQty).toBe(0);
  });

  // Строка разнесения заведена, но объём в ней не проставлен — по сути
  // разнесения нет, и молчать нельзя
  it('строка без объёма разнесением не считается', () => {
    const s = allocationSummary(req({
      actualQty: 10, actualAmount: 450000, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [{ actualQty: null, actualAmount: null, order: { id: 'o-1', orderNumber: '1' } }],
    }), 7, NOW);
    expect(s.needsAllocation).toBe(true);
    expect(s.allocatedQty).toBe(0);
    expect(s.allocatedAmount).toBe(0);
  });
});

describe('allocationSummary: totalAmount — акт важнее оценки, оценка важнее ставки', () => {
  // Приоритет один и тот же во всех отчётах по подряду; перепутать его —
  // значит показать директору плановую сумму вместо подписанной
  it('есть акт — берётся сумма акта', () => {
    const s = allocationSummary(req({
      actualQty: 12, actualAmount: 520000, estimatedAmount: 480000, plannedQty: 10, rate: 45000,
      acceptedAt: D('2026-08-25T10:00:00Z'),
    }), 7, NOW);
    expect(s.totalAmount).toBe(520000);
  });

  it('акта нет — берётся согласованная оценка, а не ставка × объём', () => {
    const s = allocationSummary(req({ estimatedAmount: 480000, plannedQty: 10, rate: 45000 }), 7, NOW);
    expect(s.totalAmount).toBe(480000);
  });

  it('нет ни акта, ни оценки — считается ставка × плановый объём', () => {
    const s = allocationSummary(req({ plannedQty: 10, rate: 45000 }), 7, NOW);
    expect(s.totalAmount).toBe(450000);
  });

  // Ноль в акте — это решение («работу не оплачиваем»), а не отсутствие
  // данных: подставлять поверх него оценку нельзя
  it('нулевой акт вытесняет оценку, а не проваливается к ней', () => {
    const s = allocationSummary(req({
      actualQty: 10, actualAmount: 0, estimatedAmount: 480000, acceptedAt: D('2026-08-25T10:00:00Z'),
    }), 7, NOW);
    expect(s.totalAmount).toBe(0);
  });

  it('ставка × объём округляется до копейки', () => {
    const s = allocationSummary(req({ plannedQty: 3, rate: 1000.335 }), 7, NOW);
    expect(s.totalAmount).toBe(3001.01);
  });

  it('нечего считать — totalAmount пустой, а не ноль', () => {
    const s = allocationSummary(req({ plannedQty: null, rate: null }), 7, NOW);
    expect(s.totalAmount).toBeNull();
    // Объём неизвестен — честный null; по деньгам поле схлопывается в 0
    expect(s.unallocatedQty).toBeNull();
    expect(s.unallocatedAmount).toBe(0);
  });
});

describe('allocationSummary: переразнесение не даёт отрицательного остатка', () => {
  // Разнесли больше, чем приняли (акт потом урезали). Минус в остатке
  // попал бы в сводку как «подрядчику должны −90 000» и сломал бы итоги
  it('разнесено больше акта — остаток ноль, а не минус', () => {
    const s = allocationSummary(req({
      actualQty: 10, actualAmount: 450000, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(12, 540000, '1')],
    }), 7, NOW);
    expect(s.unallocatedAmount).toBe(0);
    expect(s.unallocatedQty).toBe(0);
    // Само переразнесение при этом видно: разнесено больше, чем всего
    expect(s.allocatedAmount).toBe(540000);
    expect(s.totalAmount).toBe(450000);
  });
});

describe('allocationSummary: isStale — заявка зависла после приёмки', () => {
  const stuck = (acceptedAt: Date, works: RequestLike['works'] = []) => allocationSummary(
    req({ actualQty: 10, actualAmount: 450000, acceptedAt, works }), 7, NOW,
  );

  // Явный `now` в аргументах — чтобы тест не начал падать в другой день
  it('ровно staleDays от приёмки и не разнесена — зависла', () => {
    const s = stuck(D('2026-08-19T12:00:00Z'));
    expect(s.daysSinceAccepted).toBe(7);
    expect(s.isStale).toBe(true);
  });

  it('на сутки меньше порога — ещё не зависла', () => {
    const s = stuck(D('2026-08-19T13:00:00Z'));
    expect(s.daysSinceAccepted).toBe(6);
    expect(s.isStale).toBe(false);
  });

  // Разнесённая заявка не «висит», сколько бы ни прошло: работа лежит
  // в заказах, торопить некого
  it('разнесена полностью — не зависла даже спустя месяц', () => {
    const s = stuck(D('2026-07-01T12:00:00Z'), [work(4, 180000, '1'), work(6, 270000, '2')]);
    expect(s.daysSinceAccepted).toBe(56);
    expect(s.isStale).toBe(false);
    expect(s.needsAllocation).toBe(false);
  });

  it('разнесена частично и давно — зависла', () => {
    const s = stuck(D('2026-07-01T12:00:00Z'), [work(4, 180000, '1')]);
    expect(s.isStale).toBe(true);
  });

  it('не принята — зависать нечему', () => {
    const s = allocationSummary(req({ acceptedAt: null, status: 'SENT' }), 7, NOW);
    expect(s.isStale).toBe(false);
  });

  it('порог настраиваемый: с staleDays=30 та же заявка ещё в норме', () => {
    const s = allocationSummary(
      req({ actualQty: 10, actualAmount: 450000, acceptedAt: D('2026-08-16T12:00:00Z') }), 30, NOW,
    );
    expect(s.daysSinceAccepted).toBe(10);
    expect(s.isStale).toBe(false);
    expect(s.needsAllocation).toBe(true);
  });
});

describe('allocationSummary: Decimal из Prisma считается как число', () => {
  // Prisma отдаёт Decimal-объекты, а не числа. Одна забытая конвертация —
  // и вместо суммы получается склейка строк или NaN в отчёте по подряду
  const shape = (v: (n: string) => unknown) => req({
    plannedQty: v('10.000'),
    rate: v('1000.50'),
    actualQty: v('10.000'),
    actualAmount: v('10005.00'),
    plannedHours: v('36.500'),
    acceptedAt: D('2026-08-25T10:00:00Z'),
    works: [
      { actualQty: v('4.000'), actualAmount: v('4002.00'), order: { id: 'o-1', orderNumber: '1' } },
      { actualQty: v('6.000'), actualAmount: v('6003.00'), order: { id: 'o-2', orderNumber: '2' } },
    ],
  });

  const asNumber = allocationSummary(shape((n) => Number(n)), 7, NOW);
  const asString = allocationSummary(shape((n) => n), 7, NOW);
  const asDecimal = allocationSummary(shape((n) => new Prisma.Decimal(n)), 7, NOW);

  it('строки "1000.50" дают то же, что числа 1000.5', () => {
    expect(asString).toEqual(asNumber);
  });

  it('Prisma.Decimal даёт то же, что числа', () => {
    expect(asDecimal).toEqual(asNumber);
  });

  it('значения действительно числовые, а не склеенные строки', () => {
    expect(asDecimal.rate).toBe(1000.5);
    expect(asDecimal.totalAmount).toBe(10005);
    expect(asDecimal.allocatedAmount).toBe(10005);
    expect(asDecimal.allocatedQty).toBe(10);
    expect(asDecimal.plannedHours).toBe(36.5);
    expect(asDecimal.needsAllocation).toBe(false);
    expect(asDecimal.unallocatedAmount).toBe(0);
  });

  it('пустой Decimal остаётся пустым, а не превращается в ноль', () => {
    const s = allocationSummary(req({ plannedQty: null, rate: null, actualAmount: null }), 7, NOW);
    expect(s.rate).toBeNull();
    expect(s.actualAmount).toBeNull();
  });
});

describe('allocationSummary: подписи для человека', () => {
  // Строку списка читает снабженец, а не разработчик: код передела и код
  // ставки сами по себе ему ничего не говорят
  it('передел и единица ставки подписаны по-русски', () => {
    const s = allocationSummary(req({ routingStage: 'CUTTING', rateType: 'PER_HOUR' }), 7, NOW);
    expect(s.stageLabel).toBe(STAGE_LABELS.CUTTING);
    expect(s.unit).toBe(RATE_UNITS.PER_HOUR);
  });

  // Новый код передела не должен превращать строку в пустое место —
  // лучше показать сам код, чем ничего
  it('незнакомый код передела показывается как есть', () => {
    const s = allocationSummary(req({ routingStage: 'WELDING', rateType: 'PER_METER' }), 7, NOW);
    expect(s.stageLabel).toBe('WELDING');
    expect(s.unit).toBe('');
  });

  it('заказы разнесения перечислены для карточки', () => {
    const s = allocationSummary(req({
      actualQty: 10, actualAmount: 450000, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(4, 180000, '2026-118'), work(6, 270000, '2026-119')],
    }), 7, NOW);
    expect(s.orders.map((o) => o!.orderNumber)).toEqual(['2026-118', '2026-119']);
  });
});

/**
 * Регресс на дефекты, найденные состязательной проверкой 26.08.2026.
 * Каждый из них давал НЕВЕРНОЕ ЧИСЛО в себестоимости заказа, а не
 * неудобство, поэтому проверяем ровно то число.
 */
describe('allocationSummary: деньги за неразнесённый объём не растворяются', () => {
  // Раньше unallocatedAmount считался как «сумма заявки минус сумма строк»,
  // а раскладка всегда отдавала строкам ровно весь акт. Разница вычиталась
  // сама из себя, и «висит 0 ₸» показывалось именно тогда, когда деньги
  // висели по-настоящему: приняли 12 т на 1 200 000 ₸, разнесли 8 — и
  // на дашборде было «одна заявка висит, 0 ₸».
  it('разнесено 8 т из 12 — висит 400 000 ₸, а не ноль', () => {
    const s = allocationSummary(req({
      actualQty: 12, actualAmount: 1_200_000, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(8, 800_000, '2026-201')],
    }), 7, NOW);
    expect(s.unallocatedQty).toBe(4);
    expect(s.unallocatedAmount).toBe(400_000);
    expect(s.needsAllocation).toBe(true);
  });

  it('разнесено полностью — не висит ничего', () => {
    const s = allocationSummary(req({
      actualQty: 12, actualAmount: 1_200_000, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(4, 400_000, '2026-201'), work(8, 800_000, '2026-202')],
    }), 7, NOW);
    expect(s.unallocatedQty).toBe(0);
    expect(s.unallocatedAmount).toBe(0);
    expect(s.needsAllocation).toBe(false);
  });

  // Объём принят не был, а деньги есть: одна строка гасила флаг целиком,
  // унося с собой всё, что не разнесли
  it('объёма нет, но деньги не разнесены — флаг всё равно поднят', () => {
    const s = allocationSummary(req({
      plannedQty: null, actualQty: null, actualAmount: 900_000,
      acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(1, 495_000, '2026-203')],
    }), 7, NOW);
    expect(s.unallocatedAmount).toBe(405_000);
    expect(s.needsAllocation).toBe(true);
  });

  // «Висит 0 ₸» и «сумма заявки вообще неизвестна» — разные вещи, и
  // вторая не должна бесследно растворяться в сводке
  it('сумма заявки неизвестна — это отдельный признак, а не ноль', () => {
    const s = allocationSummary(req({ rate: null, plannedQty: null }), 7, NOW);
    expect(s.totalAmount).toBeNull();
    expect(s.amountUnknown).toBe(true);
  });
});

describe('allocationSummary: считаем заказы, а не строки', () => {
  // Разнесение может стоять на двух позициях одного заказа: «разнесено
  // на 2 заказа» было бы неправдой, а список заказов показал бы один
  // и тот же заказ дважды
  it('две строки одного заказа — это один заказ', () => {
    const s = allocationSummary(req({
      actualQty: 10, actualAmount: 500_000, acceptedAt: D('2026-08-25T10:00:00Z'),
      works: [work(4, 200_000, '2026-301'), work(6, 300_000, '2026-301')],
    }), 7, NOW);
    expect(s.ordersCount).toBe(1);
    expect(s.orders).toHaveLength(1);
  });
});

describe('allocationSummary: отменённая заявка не висит', () => {
  // ПОДР-001 приняли, потом сняли разнесение и отменили. Деньги отозваны,
  // но acceptedAt остался — и заявка навсегда поселилась бы в красной
  // строке «подряд не разнесён» с полной суммой акта
  it('CANCELLED не попадает в «нужно разнести», сколько бы ни висело чисел', () => {
    const s = allocationSummary(req({
      status: 'CANCELLED',
      actualQty: 12, actualAmount: 1_200_000, acceptedAt: D('2026-08-10T10:00:00Z'),
      works: [],
    }), 7, NOW);
    expect(s.needsAllocation).toBe(false);
    expect(s.isStale).toBe(false);
  });
});
