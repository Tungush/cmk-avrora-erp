/**
 * Резервы партий и перехват (09_COSTING_AND_STAGES.md §4.4).
 *
 * Резерв мягкий: он не мешает кладовщику выдать металл, но не даёт второму
 * менеджеру молча посчитать заказ по партии, которой ему не достанется.
 */

export type ReservationStatusValue = 'ACTIVE' | 'RELEASED' | 'OVERRIDDEN' | 'EXPIRED';

export interface ReservationLike {
  id: string;
  batchId: string;
  orderId: string;
  qty: number;
  status: ReservationStatusValue;
  expiresAt: Date | string;
}

/** Заказ не ушёл в производство за 30 дней — резерв снимается сам */
export const DEFAULT_RESERVATION_TTL_DAYS = 30;
/** За сколько дней предупредить менеджера */
export const DEFAULT_RESERVATION_WARN_DAYS = 3;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function reservationExpiry(from: Date, ttlDays = DEFAULT_RESERVATION_TTL_DAYS): Date {
  return new Date(from.getTime() + ttlDays * DAY_MS);
}

export function daysUntil(expiresAt: Date | string, now: Date): number {
  return Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS);
}

export function isExpired(r: ReservationLike, now: Date): boolean {
  return r.status === 'ACTIVE' && new Date(r.expiresAt).getTime() <= now.getTime();
}

export function isExpiringSoon(
  r: ReservationLike,
  now: Date,
  warnDays = DEFAULT_RESERVATION_WARN_DAYS,
): boolean {
  if (r.status !== 'ACTIVE') return false;
  const left = daysUntil(r.expiresAt, now);
  return left > 0 && left <= warnDays;
}

export interface BatchAvailability {
  batchId: string;
  qtyRemaining: number;
  /** Занято чужими активными резервами */
  reservedByOthers: number;
  /** Уже занято под этот же заказ — своё себе не мешает */
  reservedByThisOrder: number;
  /** Сколько реально можно взять */
  freeQty: number;
  blockers: Array<{ reservationId: string; orderId: string; qty: number; expiresAt: Date | string }>;
}

/**
 * Свободный остаток партии с точки зрения конкретного заказа.
 * Собственный резерв не считается препятствием: пересчёт своей же калькуляции
 * не должен внезапно упираться в самого себя.
 */
export function availabilityOf(
  batch: { id: string; qtyRemaining: number },
  reservations: ReservationLike[],
  forOrderId?: string | null,
): BatchAvailability {
  const active = reservations.filter((r) => r.status === 'ACTIVE' && r.batchId === batch.id);
  const own = active.filter((r) => forOrderId != null && r.orderId === forOrderId);
  const others = active.filter((r) => forOrderId == null || r.orderId !== forOrderId);

  const reservedByOthers = round3(others.reduce((s, r) => s + r.qty, 0));
  const reservedByThisOrder = round3(own.reduce((s, r) => s + r.qty, 0));

  return {
    batchId: batch.id,
    qtyRemaining: round3(batch.qtyRemaining),
    reservedByOthers,
    reservedByThisOrder,
    freeQty: round3(Math.max(0, batch.qtyRemaining - reservedByOthers)),
    blockers: others.map((r) => ({
      reservationId: r.id,
      orderId: r.orderId,
      qty: r.qty,
      expiresAt: r.expiresAt,
    })),
  };
}

/**
 * Что мешает взять нужный объём и можно ли обойтись без согласования.
 * Пока запрос висит, менеджер не заблокирован: он считает по свободным
 * партиям и работает дальше.
 */
export function assessRequest(
  availability: BatchAvailability,
  wantQty: number,
): {
  fits: boolean;
  shortfall: number;
  needsOverride: boolean;
  message: string;
} {
  const shortfall = round3(Math.max(0, wantQty - availability.freeQty));
  if (shortfall <= 0) {
    return { fits: true, shortfall: 0, needsOverride: false, message: 'Партия доступна' };
  }
  if (availability.reservedByOthers <= 0) {
    return {
      fits: false,
      shortfall,
      needsOverride: false,
      message: `Не хватает ${shortfall} — на складе просто нет столько`,
    };
  }
  return {
    fits: false,
    shortfall,
    needsOverride: true,
    message: `Свободно ${availability.freeQty}, ещё ${shortfall} зарезервировано под другие заказы`,
  };
}

/** Разбор пачки резервов на «просрочены» и «истекают» — для фонового снятия */
export function classifyReservations(
  reservations: ReservationLike[],
  now: Date,
  warnDays = DEFAULT_RESERVATION_WARN_DAYS,
) {
  return {
    expired: reservations.filter((r) => isExpired(r, now)),
    expiringSoon: reservations.filter((r) => isExpiringSoon(r, now, warnDays)),
  };
}
