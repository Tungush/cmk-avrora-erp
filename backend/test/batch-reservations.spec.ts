import {
  availabilityOf, assessRequest, reservationExpiry, daysUntil,
  isExpired, isExpiringSoon, classifyReservations, ReservationLike,
  DEFAULT_RESERVATION_TTL_DAYS, DEFAULT_RESERVATION_WARN_DAYS,
} from '../src/common/batch-reservations';

const BATCH = { id: 'b-apr', qtyRemaining: 890 };
const FUTURE = '2026-09-25';

const res = (over: Partial<ReservationLike> = {}): ReservationLike => ({
  id: 'r-1', batchId: 'b-apr', orderId: 'заказ-А', qty: 800,
  status: 'ACTIVE', expiresAt: FUTURE, ...over,
});

describe('Свободный остаток партии (09 §4.4)', () => {
  it('чужой резерв уменьшает доступное', () => {
    const a = availabilityOf(BATCH, [res()], 'заказ-Б');
    expect(a.reservedByOthers).toBe(800);
    expect(a.freeQty).toBe(90);
  });

  it('собственный резерв себе не мешает — пересчёт своей калькуляции не упрётся в себя', () => {
    const a = availabilityOf(BATCH, [res()], 'заказ-А');
    expect(a.reservedByThisOrder).toBe(800);
    expect(a.reservedByOthers).toBe(0);
    expect(a.freeQty).toBe(890);
  });

  it('снятые и перехваченные резервы не занимают ничего', () => {
    const a = availabilityOf(BATCH, [
      res({ id: 'r-1', status: 'RELEASED' }),
      res({ id: 'r-2', status: 'OVERRIDDEN' }),
      res({ id: 'r-3', status: 'EXPIRED' }),
    ], 'заказ-Б');
    expect(a.freeQty).toBe(890);
  });

  it('видно, кто именно держит партию', () => {
    const a = availabilityOf(BATCH, [res()], 'заказ-Б');
    expect(a.blockers).toEqual([
      { reservationId: 'r-1', orderId: 'заказ-А', qty: 800, expiresAt: FUTURE },
    ]);
  });
});

describe('Нужно ли согласование', () => {
  it('хватает свободного — работаем без директора', () => {
    const a = availabilityOf(BATCH, [res()], 'заказ-Б');
    expect(assessRequest(a, 90)).toMatchObject({ fits: true, needsOverride: false });
  });

  it('не хватает из-за чужого резерва — нужен перехват', () => {
    const a = availabilityOf(BATCH, [res()], 'заказ-Б');
    const r = assessRequest(a, 500);
    expect(r.needsOverride).toBe(true);
    expect(r.shortfall).toBe(410);
    expect(r.message).toContain('зарезервировано под другие заказы');
  });

  it('не хватает потому, что металла просто нет — согласовывать нечего', () => {
    const a = availabilityOf({ id: 'b', qtyRemaining: 50 }, [], 'заказ-Б');
    const r = assessRequest(a, 500);
    expect(r.needsOverride).toBe(false);
    expect(r.message).toContain('просто нет столько');
  });
});

describe('Срок жизни резерва: 30 дней без движения', () => {
  const now = new Date('2026-08-20T00:00:00Z');

  it('срок по умолчанию — 30 дней от согласования', () => {
    expect(DEFAULT_RESERVATION_TTL_DAYS).toBe(30);
    expect(daysUntil(reservationExpiry(now), now)).toBe(30);
  });

  it('просроченный резерв определяется по дате, а не по статусу заказа', () => {
    expect(isExpired(res({ expiresAt: '2026-08-19' }), now)).toBe(true);
    expect(isExpired(res({ expiresAt: '2026-08-21' }), now)).toBe(false);
  });

  it('уже снятый резерв повторно не протухает', () => {
    expect(isExpired(res({ expiresAt: '2026-08-01', status: 'EXPIRED' }), now)).toBe(false);
  });

  it('предупреждение приходит за три дня', () => {
    expect(DEFAULT_RESERVATION_WARN_DAYS).toBe(3);
    expect(isExpiringSoon(res({ expiresAt: '2026-08-22' }), now)).toBe(true);
    expect(isExpiringSoon(res({ expiresAt: '2026-08-30' }), now)).toBe(false);
  });

  it('просроченный уже не «истекает скоро» — иначе он попадёт в оба списка', () => {
    expect(isExpiringSoon(res({ expiresAt: '2026-08-19' }), now)).toBe(false);
  });

  it('разбор пачки делит резервы на снятие и предупреждение', () => {
    const c = classifyReservations([
      res({ id: 'просрочен', expiresAt: '2026-08-10' }),
      res({ id: 'истекает', expiresAt: '2026-08-22' }),
      res({ id: 'живой', expiresAt: '2026-09-15' }),
    ], now);
    expect(c.expired.map((r) => r.id)).toEqual(['просрочен']);
    expect(c.expiringSoon.map((r) => r.id)).toEqual(['истекает']);
  });
});
