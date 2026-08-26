/**
 * Арифметика разнесения заявки на подряд по заказам (26.08.2026).
 *
 * Вынесена из контроллера намеренно: это единственное место, где деньги
 * подрядчика делятся между заказами, и оно обязано быть покрыто тестами
 * без базы. Инвариант ровно один и он проверяемый: сумма долей копейка
 * в копейку равна принятой сумме акта.
 */

export const RATE_UNITS: Record<string, string> = {
  PER_HOUR: 'ч', PER_UNIT: 'шт', PER_KG: 'кг', PER_TON: 'т', FIXED: 'ед.',
};

export const STAGE_LABELS: Record<string, string> = {
  CUTTING: 'Резка',
  ASSEMBLY: 'Сборка / сварка / обшивка',
  PAINTING: 'Зачистка / покраска',
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Разделить СУММУ по объёмам так, чтобы части сошлись в исходную копейка
 * в копейку. Последняя доля — остаток, а не своё округление: три заказа
 * по 1/3 от 1 000 000 ₸ иначе дают 999 999,99 и вечное расхождение с актом.
 *
 * Нулевые объёмы получают ноль: разносить деньги на заказ, куда ничего
 * не ушло, нельзя.
 */
export function splitAmount(total: number, qtys: number[]): number[] {
  const sum = qtys.reduce((s, q) => s + Math.max(0, q), 0);
  if (!(sum > 0)) return qtys.map(() => 0);

  const parts = qtys.map((q) => round2((total * Math.max(0, q)) / sum));
  // Последняя НЕнулевая доля забирает остаток округления
  let lastIdx = -1;
  for (let i = qtys.length - 1; i >= 0; i -= 1) {
    if (qtys[i] > 0) { lastIdx = i; break; }
  }
  if (lastIdx >= 0) {
    const others = parts.reduce((s, p, i) => (i === lastIdx ? s : s + p), 0);
    parts[lastIdx] = round2(total - others);
  }
  return parts;
}

/**
 * Разделить величину, которой точное схождение не требуется — часы.
 * Отдельная функция, чтобы не соблазняться использовать её для денег.
 */
export function splitProportional(total: number, qtys: number[]): number[] {
  const sum = qtys.reduce((s, q) => s + Math.max(0, q), 0);
  if (!(sum > 0)) return qtys.map(() => 0);
  return qtys.map((q) => round3((total * Math.max(0, q)) / sum));
}

export interface RequestLike {
  id: string;
  number: string;
  routingStage: string;
  rateType: string;
  status: string;
  plannedQty: unknown;
  rate: unknown;
  estimatedAmount: unknown;
  actualQty: unknown;
  actualAmount: unknown;
  acceptedAt: Date | null;
  bitrixDealId: string | null;
  bitrixSentAt: Date | null;
  workLocation: string;
  plannedHours: unknown;
  createdAt: Date;
  contractor?: { id: string; name: string; binIin?: string | null } | null;
  works: Array<{
    actualQty: unknown;
    actualAmount: unknown;
    order?: { id: string; orderNumber: string } | null;
  }>;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Строка списка заявок: что отдано, что разнесено, что висит.
 *
 * `needsAllocation` — самая опасная точка потока и потому отдельное поле:
 * работа принята и оплачивается, но не сидит ни в одном заказе. Подряд
 * при этом занижен, а штат на его виде работ считается по норме на все
 * 100 %. Тишины здесь быть не должно.
 */
export function allocationSummary(r: RequestLike, staleDays = 7, now: Date = new Date()) {
  const allocatedQty = r.works.reduce((s, w) => s + (num(w.actualQty) ?? 0), 0);
  const allocatedAmount = r.works.reduce((s, w) => s + (num(w.actualAmount) ?? 0), 0);

  const actualQty = num(r.actualQty);
  const actualAmount = num(r.actualAmount);
  const plannedQty = num(r.plannedQty);
  const rate = num(r.rate);
  const estimatedAmount = num(r.estimatedAmount);

  // Сколько всего денег в заявке: акт важнее оценки, оценка важнее ставки
  const totalAmount = actualAmount
    ?? estimatedAmount
    ?? (plannedQty != null && rate != null ? round2(plannedQty * rate) : null);

  const targetQty = actualQty ?? plannedQty;
  const unallocatedQty = targetQty != null ? round3(Math.max(0, targetQty - allocatedQty)) : null;
  const daysSinceAccepted = r.acceptedAt
    ? Math.floor((now.getTime() - r.acceptedAt.getTime()) / 86_400_000)
    : null;

  /**
   * Деньги считаем от НЕРАЗНЕСЁННОГО ОБЪЁМА, а не как «сумма минус сумма
   * строк». Разница вычиталась сама из себя — раскладка всегда отдавала
   * строкам ровно весь акт, и «висит» показывало 0 ₸ ровно тогда, когда
   * деньги висели по-настоящему.
   */
  const unallocatedAmount = totalAmount == null
    ? null
    : (targetQty != null && targetQty > 0 && unallocatedQty != null
      ? round2((totalAmount * unallocatedQty) / targetQty)
      : (r.works.length === 0 ? round2(totalAmount) : round2(Math.max(0, totalAmount - allocatedAmount))));

  // Висит, если не разнесён объём ЛИБО деньги: заявка без объёма и с одной
  // строкой раньше гасила флаг, унося с собой все неразнесённые деньги.
  // Отменённая заявка не висит ни при каких числах — её деньги отозваны
  const hasUnallocated = r.status !== 'CANCELLED' && (r.works.length === 0
    || (unallocatedQty != null && unallocatedQty > 1e-6)
    || (unallocatedAmount != null && unallocatedAmount > 0.005));

  return {
    id: r.id,
    number: r.number,
    routingStage: r.routingStage,
    stageLabel: STAGE_LABELS[r.routingStage] ?? r.routingStage,
    status: r.status,
    rateType: r.rateType,
    unit: RATE_UNITS[r.rateType] ?? '',
    rate,
    plannedQty,
    estimatedAmount,
    actualQty,
    actualAmount,
    totalAmount,
    workLocation: r.workLocation,
    plannedHours: num(r.plannedHours),
    contractor: r.contractor ?? null,
    bitrixDealId: r.bitrixDealId,
    bitrixSentAt: r.bitrixSentAt,
    acceptedAt: r.acceptedAt,
    createdAt: r.createdAt,
    daysSinceAccepted,
    // Заказов, а не строк: разнесение может стоять на двух позициях
    // одного заказа, и «разнесено на 2 заказа» было бы неправдой
    ordersCount: new Set(r.works.map((w) => w.order?.id).filter(Boolean)).size,
    orders: [...new Map(r.works.map((w) => w.order).filter(Boolean)
      .map((o) => [(o as { id: string }).id, o])).values()],
    allocatedQty: round3(allocatedQty),
    allocatedAmount: round2(allocatedAmount),
    unallocatedQty,
    unallocatedAmount: unallocatedAmount ?? 0,
    /** Сумма заявки вообще неизвестна — это не «висит ноль» */
    amountUnknown: totalAmount == null,
    // Принята, но по заказам не разошлась — деньги висят в воздухе
    needsAllocation: r.acceptedAt != null && hasUnallocated,
    isStale: r.acceptedAt != null && hasUnallocated && (daysSinceAccepted ?? 0) >= staleDays,
  };
}
